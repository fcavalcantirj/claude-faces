// STT auto-selection — the SINGLE entry point for speech-to-text.
//
// Both the push-to-talk recorder and the hands-free VAD hand their captured clip
// to `transcribe(blob, { mode })`. This module owns the routing between the two
// engines the app ships:
//
//   - the in-browser Whisper worker (WebGPU/WASM, offline, $0, private), and
//   - the hosted `/api/transcribe` fallback (Groq / OpenAI Whisper).
//
// In `auto` mode the browser worker is preferred WHENEVER it is usable AND the
// model is already cached — so a returning/offline user transcribes locally with
// no network and no surprise ~150 MB download. On a worker error, a timeout, a
// missing (uncached) model, or an unsupported browser, it POSTs the clip to the
// hosted route (after confirming a hosted key exists via `/api/config`). With
// NEITHER path available it throws a typed `SttError('no_stt_available')` the UI
// can turn into a clear "add a key or download the model" message while keeping
// text input working.
//
// The routing core is PURE over its injected `SttDeps`, so it is fully headlessly
// testable with fakes — no Worker, no fetch, no WebGPU. `defaultSttDeps()` wires
// the real browser worker + hosted client at runtime.

import {
  DEFAULT_WHISPER_MODEL,
  type WhisperBackend,
} from "./whisper-engine";
import { probeModelCached } from "./model-status";
import type { WhisperRequest, WhisperResponse } from "./whisper-worker";
import type { TranscribeResult } from "./hosted";

// --- Public types -----------------------------------------------------------

/** Which STT path to use. `auto` = browser-first, hosted fallback. */
export type SttMode = "browser" | "hosted" | "auto";

/** Which engine actually served a transcript (surfaced in the HUD). */
export type SttEngine = "browser" | "hosted";

/** Machine-readable failure code the UI maps to an explanatory message. */
export type SttErrorCode =
  | "no_stt_available" // neither the browser worker nor a hosted key can serve
  | "browser_unavailable" // forced browser mode, but WebGPU/WASM is unusable
  | "hosted_unavailable" // forced hosted mode, but no hosted STT key is set
  | "transcription_failed"; // an engine was reached but transcription errored

/** A completed transcription plus provenance for the HUD. */
export interface SttResult {
  text: string;
  /** The engine that produced this transcript. */
  engine: SttEngine;
  /** Execution backend when `engine === 'browser'`. */
  backend?: WhisperBackend;
  /** Upstream provider when `engine === 'hosted'`. */
  provider?: "groq" | "openai";
  /** Model id used (browser model or hosted model). */
  model?: string;
  /** Hosted round-trip latency (ms), when reported. */
  latencyMs?: number;
}

/** Typed STT failure. `code` lets the UI explain what to do next. */
export class SttError extends Error {
  readonly code: SttErrorCode;
  readonly cause?: unknown;

  constructor(code: SttErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "SttError";
    this.code = code;
    this.cause = cause;
    Object.setPrototypeOf(this, SttError.prototype);
  }
}

/** Per-call options. */
export interface TranscribeOptions {
  /** Routing strategy; default `auto`. */
  mode?: SttMode;
  /** BCP-47 language hint passed to both engines. */
  language?: string;
  /** Vocabulary/context prompt (hosted providers only). */
  prompt?: string;
  /** Abort in-flight work (barge-in). */
  signal?: AbortSignal;
  /**
   * Max wall-clock (ms) to wait on the in-browser worker in `auto` mode before
   * abandoning it for the hosted fallback. Default {@link DEFAULT_BROWSER_TIMEOUT_MS}.
   */
  browserTimeoutMs?: number;
}

// --- Engine seams (injectable) ----------------------------------------------

/** The in-browser Whisper worker, abstracted for headless testing. */
export interface BrowserSttEngine {
  /** WebGPU/WASM + Worker usable in this environment? */
  isSupported(): boolean | Promise<boolean>;
  /** Model shards already in Cache Storage (offline-ready, no re-download)? */
  isModelCached(): Promise<boolean>;
  /** Transcribe a clip locally. Throws on worker/OOM failure. */
  transcribe(
    blob: Blob,
    opts?: { language?: string; signal?: AbortSignal },
  ): Promise<{ text: string; backend: WhisperBackend }>;
}

/** The hosted `/api/transcribe` fallback, abstracted for headless testing. */
export interface HostedSttEngine {
  /** A hosted STT key exists server-side (probed via `/api/config`). */
  isAvailable(): Promise<boolean>;
  /** POST the clip to `/api/transcribe`. Throws {@link SttError} on failure. */
  transcribe(
    blob: Blob,
    opts?: { language?: string; prompt?: string; signal?: AbortSignal },
  ): Promise<TranscribeResult>;
}

/** Injectable engines; defaults wire the real browser worker + hosted client. */
export interface SttDeps {
  browser?: BrowserSttEngine;
  hosted?: HostedSttEngine;
}

/** Default patience for the in-browser worker before routing hosted. */
export const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;

// --- Routing core -----------------------------------------------------------

/**
 * Transcribe a recorded clip, selecting the engine per `options.mode`.
 * This is the ONE entry point push-to-talk and VAD both call.
 */
export async function transcribe(
  blob: Blob,
  options: TranscribeOptions = {},
  deps: SttDeps = defaultSttDeps(),
): Promise<SttResult> {
  const mode = options.mode ?? "auto";
  switch (mode) {
    case "browser":
      return transcribeBrowserOnly(blob, options, deps);
    case "hosted":
      return transcribeHostedOnly(blob, options, deps);
    case "auto":
    default:
      return transcribeAuto(blob, options, deps);
  }
}

/** Forced browser: never silently falls back to hosted. */
async function transcribeBrowserOnly(
  blob: Blob,
  options: TranscribeOptions,
  deps: SttDeps,
): Promise<SttResult> {
  const { browser } = deps;
  if (!browser || !(await browser.isSupported())) {
    throw new SttError(
      "browser_unavailable",
      "In-browser Whisper is not available here (needs WebGPU or WASM). Choose hosted STT or enable a hosted key.",
    );
  }
  return runBrowser(browser, blob, options);
}

/** Forced hosted: requires a hosted key. */
async function transcribeHostedOnly(
  blob: Blob,
  options: TranscribeOptions,
  deps: SttDeps,
): Promise<SttResult> {
  const { hosted } = deps;
  if (!hosted || !(await hosted.isAvailable())) {
    throw new SttError(
      "hosted_unavailable",
      "No hosted speech-to-text is configured. Set GROQ_API_KEY or OPENAI_API_KEY, or use in-browser Whisper.",
    );
  }
  return runHosted(hosted, blob, options);
}

/**
 * Browser-first: use the in-browser worker when it is supported AND the model is
 * cached; on any failure (worker error, timeout) or when it is not usable, route
 * to hosted. Only when neither path can serve do we throw `no_stt_available`.
 */
async function transcribeAuto(
  blob: Blob,
  options: TranscribeOptions,
  deps: SttDeps,
): Promise<SttResult> {
  const { browser, hosted } = deps;

  // Prefer the browser worker only when it is BOTH usable and already cached —
  // an uncached model would trigger a ~150 MB download, so we route hosted then.
  let browserFailure: unknown;
  if (browser && (await browser.isSupported()) && (await browser.isModelCached())) {
    try {
      const timeoutMs = options.browserTimeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
      return await withTimeout(runBrowser(browser, blob, options), timeoutMs);
    } catch (err) {
      // Worker error / OOM / timeout — fall through to the hosted fallback.
      browserFailure = err;
    }
  }

  if (hosted && (await hosted.isAvailable())) {
    return runHosted(hosted, blob, options);
  }

  throw new SttError(
    "no_stt_available",
    "No speech-to-text is available: the in-browser model is not ready and no hosted key is set. Download the model or add GROQ_API_KEY / OPENAI_API_KEY. You can still type.",
    browserFailure,
  );
}

async function runBrowser(
  browser: BrowserSttEngine,
  blob: Blob,
  options: TranscribeOptions,
): Promise<SttResult> {
  const { text, backend } = await browser.transcribe(blob, {
    language: options.language,
    signal: options.signal,
  });
  return { text, engine: "browser", backend, model: DEFAULT_WHISPER_MODEL };
}

async function runHosted(
  hosted: HostedSttEngine,
  blob: Blob,
  options: TranscribeOptions,
): Promise<SttResult> {
  const r = await hosted.transcribe(blob, {
    language: options.language,
    prompt: options.prompt,
    signal: options.signal,
  });
  return {
    text: r.text,
    engine: "hosted",
    provider: r.provider,
    model: r.model,
    latencyMs: r.latencyMs,
  };
}

/** Reject with a timeout {@link SttError} if `promise` outlives `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new SttError(
          "transcription_failed",
          `In-browser transcription exceeded ${ms} ms.`,
        ),
      );
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// --- Default hosted client (fetch → /api/transcribe) ------------------------

/** Shape of the `/api/config` STT capability booleans this client reads. */
interface ConfigSttShape {
  stt?: { groq?: boolean; openai?: boolean };
}

export interface CreateHostedSttOptions {
  /** Override fetch (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Config probe path. Default `/api/config`. */
  configPath?: string;
  /** Transcribe route path. Default `/api/transcribe`. */
  transcribePath?: string;
}

/** Build the real hosted STT client backed by `/api/transcribe` + `/api/config`. */
export function createHostedStt(options: CreateHostedSttOptions = {}): HostedSttEngine {
  const fetchImpl = options.fetchImpl ?? fetch;
  const configPath = options.configPath ?? "/api/config";
  const transcribePath = options.transcribePath ?? "/api/transcribe";

  return {
    async isAvailable(): Promise<boolean> {
      try {
        const res = await fetchImpl(configPath, { method: "GET" });
        if (!res.ok) return false;
        const data = (await res.json()) as ConfigSttShape;
        return Boolean(data.stt?.groq || data.stt?.openai);
      } catch {
        // A config probe must never throw — absence just means "no hosted STT".
        return false;
      }
    },

    async transcribe(blob, opts = {}): Promise<TranscribeResult> {
      const form = new FormData();
      form.append("audio", blob, filenameFor(blob));
      if (opts.language) form.append("language", opts.language);
      if (opts.prompt) form.append("prompt", opts.prompt);

      let res: Response;
      try {
        res = await fetchImpl(transcribePath, {
          method: "POST",
          body: form,
          signal: opts.signal,
        });
      } catch (err) {
        throw new SttError(
          "transcription_failed",
          "Could not reach the hosted transcription service.",
          err,
        );
      }

      if (!res.ok) {
        throw new SttError("transcription_failed", await errorMessageFrom(res));
      }

      const data = (await res.json()) as Partial<TranscribeResult>;
      return {
        text: typeof data.text === "string" ? data.text : "",
        provider: data.provider === "openai" ? "openai" : "groq",
        model: data.model ?? "",
        latencyMs: typeof data.latencyMs === "number" ? data.latencyMs : 0,
      };
    },
  };
}

/** Pull the route's safe error message from a failed response body. */
async function errorMessageFrom(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body?.error?.message) return body.error.message;
  } catch {
    // non-JSON body — fall through to a generic message.
  }
  return `Hosted transcription failed (HTTP ${res.status}).`;
}

/** Derive an upstream filename (providers infer the format from the extension). */
function filenameFor(blob: Blob): string {
  const type = blob.type || "";
  if (type.includes("webm")) return "audio.webm";
  if (type.includes("mp4") || type.includes("m4a")) return "audio.mp4";
  if (type.includes("ogg")) return "audio.ogg";
  if (type.includes("wav")) return "audio.wav";
  if (type.includes("mpeg") || type.includes("mp3")) return "audio.mp3";
  return "audio.webm";
}

// --- Default browser client (resident Whisper worker) -----------------------

export interface CreateBrowserSttOptions {
  modelId?: string;
  /** Spawn the worker (override in tests). Default: real dedicated Worker. */
  spawnWorker?: () => Worker;
  /** Cache probe override. Default {@link probeModelCached}. */
  probeCached?: (modelId: string) => Promise<boolean>;
}

/**
 * Build the real in-browser STT client. It keeps ONE dedicated Whisper worker
 * resident across calls (loaded once, never re-downloaded) and speaks the
 * {@link WhisperRequest}/{@link WhisperResponse} protocol from `./whisper-worker`.
 */
export function createBrowserStt(options: CreateBrowserSttOptions = {}): BrowserSttEngine {
  const modelId = options.modelId ?? DEFAULT_WHISPER_MODEL;
  const probe = options.probeCached ?? probeModelCached;

  let worker: Worker | null = null;
  let loaded: Promise<WhisperBackend> | null = null;
  let seq = 0;

  const spawn =
    options.spawnWorker ??
    (() =>
      new Worker(new URL("./whisper-worker.ts", import.meta.url), {
        type: "module",
      }));

  function ensureWorker(): Worker {
    if (!worker) worker = spawn();
    return worker;
  }

  /** Load the model once; concurrent/repeat callers share the same load. */
  function ensureLoaded(w: Worker): Promise<WhisperBackend> {
    if (loaded) return loaded;
    loaded = new Promise<WhisperBackend>((resolve, reject) => {
      const onMessage = (ev: MessageEvent<WhisperResponse>): void => {
        const msg = ev.data;
        if (msg.type === "ready") {
          w.removeEventListener("message", onMessage);
          resolve(msg.backend);
        } else if (msg.type === "error" && msg.id === undefined) {
          w.removeEventListener("message", onMessage);
          loaded = null;
          reject(new SttError("transcription_failed", msg.message));
        }
      };
      w.addEventListener("message", onMessage);
      post(w, { type: "load", modelId });
    });
    return loaded;
  }

  return {
    isSupported(): boolean {
      const g = globalThis as {
        Worker?: unknown;
        WebAssembly?: unknown;
        navigator?: { gpu?: unknown };
      };
      // A Worker + WebAssembly is the WASM floor; WebGPU is a faster bonus. Both
      // WASM threads and WebGPU also require cross-origin isolation (COOP/COEP),
      // which the app sets globally.
      return typeof g.Worker === "function" && typeof g.WebAssembly === "object";
    },

    isModelCached(): Promise<boolean> {
      return probe(modelId);
    },

    transcribe(blob, opts = {}): Promise<{ text: string; backend: WhisperBackend }> {
      const w = ensureWorker();
      const id = `t${seq++}`;
      return ensureLoaded(w).then(
        () =>
          new Promise<{ text: string; backend: WhisperBackend }>((resolve, reject) => {
            const onAbort = (): void => {
              w.removeEventListener("message", onMessage);
              reject(new SttError("transcription_failed", "Transcription aborted."));
            };
            const onMessage = (ev: MessageEvent<WhisperResponse>): void => {
              const msg = ev.data;
              if (msg.type === "result" && msg.id === id) {
                cleanup();
                resolve({ text: msg.text, backend: msg.backend });
              } else if (msg.type === "error" && msg.id === id) {
                cleanup();
                reject(new SttError("transcription_failed", msg.message));
              }
            };
            const cleanup = (): void => {
              w.removeEventListener("message", onMessage);
              opts.signal?.removeEventListener("abort", onAbort);
            };
            if (opts.signal) {
              if (opts.signal.aborted) return onAbort();
              opts.signal.addEventListener("abort", onAbort, { once: true });
            }
            w.addEventListener("message", onMessage);
            post(w, { type: "transcribe", id, blob, language: opts.language });
          }),
      );
    },
  };
}

function post(w: Worker, msg: WhisperRequest): void {
  w.postMessage(msg);
}

// --- Default deps wiring -----------------------------------------------------

let cachedDefaults: SttDeps | null = null;

/**
 * Lazily build the real engines (resident browser worker + hosted client) once
 * per session. Tests inject their own {@link SttDeps} and never hit this.
 */
export function defaultSttDeps(): SttDeps {
  if (!cachedDefaults) {
    cachedDefaults = { browser: createBrowserStt(), hosted: createHostedStt() };
  }
  return cachedDefaults;
}
