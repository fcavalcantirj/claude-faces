// All-local Kokoro-82M TTS — the main-thread facade.
//
// This is the seam the TTS router and the settings/UX layer use for the
// 'kokoro' engine. It:
//   - spawns the Kokoro Web Worker (heavy model load + synthesis off the main
//     thread) and correlates each `synthesize` request to its `audio` response,
//   - exposes a {@link ClipSynthesizer} `(text, signal) => Promise<Blob>` that
//     the router plugs into `TtsRouterDeps.kokoroSynthesize`; the router then
//     plays the returned WAV Blob through an <audio> element on the shared
//     AudioContext and taps it with the REAL FFT analyser (mouthSource
//     'analyser') — same path as OpenAI TTS,
//   - owns a small download/cache STATE MACHINE (unloaded → downloading →
//     ready | error | canceled) so a settings component can render a
//     "download model / ready, offline-capable" UX consistent with the browser
//     Whisper status, and
//   - fails SOFT: a load or synthesis failure rejects the synthesizer promise so
//     the router falls back to Web Speech, and never crashes the app.
//
// The Worker + Cache Storage are INJECTED so the whole controller runs under
// jsdom with a fake worker — no real Worker, no model download.

import { DEFAULT_KOKORO_MODEL, type KokoroBackend } from "./kokoro-engine";
import type { KokoroRequest, KokoroResponse } from "./kokoro-worker";

/** A local audio-clip synthesizer matching `TtsRouterDeps.kokoroSynthesize`. */
export type ClipSynthesizer = (text: string, signal: AbortSignal) => Promise<Blob>;

/** Lifecycle of the local Kokoro model. */
export type KokoroPhase =
  | "unloaded" // never loaded this session (may still be cached from a prior visit)
  | "downloading" // worker is fetching/initializing the model
  | "ready" // model resident — synthesis works, offline-capable
  | "error" // load failed (falls back to Web Speech)
  | "canceled"; // user skipped the download → Web Speech

export interface KokoroStatusState {
  phase: KokoroPhase;
  /** Aggregate 0..100 download percentage across all model files. */
  progress: number;
  /** Execution backend once ready (WebGPU/WASM); null until then. */
  backend: KokoroBackend | null;
  modelId: string;
  /** True once the model is in Cache Storage (persists across reloads → offline). */
  cached: boolean;
  /** Per-file download progress, keyed by file name (drives the aggregate). */
  files: Record<string, number>;
  /** Human-readable failure, when phase === 'error'. */
  error?: string;
}

/** Fresh, unloaded state for a model (default {@link DEFAULT_KOKORO_MODEL}). */
export function initialKokoroStatus(
  modelId: string = DEFAULT_KOKORO_MODEL,
): KokoroStatusState {
  return {
    phase: "unloaded",
    progress: 0,
    backend: null,
    modelId,
    cached: false,
    files: {},
  };
}

const clamp = (n: number): number => Math.max(0, Math.min(100, n));

/** Average the known per-file percentages into one overall bar value. */
function aggregate(files: Record<string, number>): number {
  const vals = Object.values(files);
  if (vals.length === 0) return 0;
  const sum = vals.reduce((a, b) => a + b, 0);
  return Math.round(sum / vals.length);
}

/**
 * Pure reducer: fold one worker {@link KokoroResponse} into the model status.
 * Ignores `audio` messages (those are synthesis results, not a load concern).
 */
export function kokoroStatusReducer(
  state: KokoroStatusState,
  msg: KokoroResponse,
): KokoroStatusState {
  switch (msg.type) {
    case "progress": {
      const phase: KokoroPhase =
        state.phase === "unloaded" ? "downloading" : state.phase;
      if (!msg.file) {
        const progress =
          typeof msg.progress === "number" ? clamp(msg.progress) : state.progress;
        return { ...state, phase, progress };
      }
      const pct =
        msg.status === "done"
          ? 100
          : typeof msg.progress === "number"
            ? clamp(msg.progress)
            : (state.files[msg.file] ?? 0);
      const files = { ...state.files, [msg.file]: pct };
      return { ...state, phase, files, progress: aggregate(files) };
    }
    case "ready":
      return {
        ...state,
        phase: "ready",
        progress: 100,
        backend: msg.backend,
        cached: true, // a successful load means the shards are now cached
        error: undefined,
      };
    case "error":
      // Only a LOAD error (no synthesis id) is a model-status concern; a
      // per-synthesis error must not knock the resident model out of 'ready'.
      if (msg.id !== undefined) return state;
      return { ...state, phase: "error", error: msg.message };
    case "audio":
    default:
      return state;
  }
}

/** A short human-readable status line for the settings/HUD component. */
export function kokoroStatusTextFor(state: KokoroStatusState): string {
  switch (state.phase) {
    case "ready":
      return `Ready, offline-capable · ${(state.backend ?? "wasm").toUpperCase()}`;
    case "downloading":
      return `Downloading voice… ${state.progress}%`;
    case "error":
      return `Voice unavailable — using Web Speech`;
    case "canceled":
      return `Skipped — using Web Speech`;
    case "unloaded":
    default:
      return state.cached
        ? "Voice cached — offline-ready"
        : `Not downloaded (~${estimateKokoroSizeMb(state.modelId)} MB)`;
  }
}

// Rough on-disk download sizes (MB) for the Kokoro ONNX builds (q8 on WASM).
const MODEL_SIZE_MB: Record<string, number> = {
  "onnx-community/Kokoro-82M-v1.0-ONNX": 86,
  "onnx-community/Kokoro-82M-ONNX": 86,
};

/** Estimated download size (MB) so the user can decide before fetching. */
export function estimateKokoroSizeMb(modelId: string): number {
  return MODEL_SIZE_MB[modelId] ?? 86;
}

// --- Cache Storage probe ----------------------------------------------------

export interface ProbeKokoroCacheDeps {
  /** Cache Storage to inspect. Default: globalThis.caches. */
  caches?: CacheStorage;
  /** Cache name transformers.js persists model shards under. */
  cacheName?: string;
}

/** transformers.js default Cache Storage bucket for downloaded model files. */
export const TRANSFORMERS_CACHE_NAME = "transformers-cache";

/**
 * Detect whether the Kokoro model's files are already in Cache Storage (i.e. a
 * prior visit downloaded them → this reload is offline-ready with no
 * re-download). Never throws: any failure or missing Cache Storage resolves
 * `false`.
 */
export async function probeKokoroCached(
  modelId: string,
  deps: ProbeKokoroCacheDeps = {},
): Promise<boolean> {
  try {
    const store =
      deps.caches ?? (globalThis as { caches?: CacheStorage }).caches ?? undefined;
    if (!store) return false;
    const cache = await store.open(deps.cacheName ?? TRANSFORMERS_CACHE_NAME);
    const keys = await cache.keys();
    return keys.some((req) => req.url.includes(modelId));
  } catch {
    return false;
  }
}

// --- Controller -------------------------------------------------------------

/** Minimal Worker surface the controller drives (real Worker satisfies it). */
export interface KokoroWorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  addEventListener?(type: "message", listener: (ev: MessageEvent) => void): void;
  onmessage?: ((ev: MessageEvent) => void) | null;
}

export interface KokoroControllerDeps {
  /** Spawn the Kokoro worker (real: `new Worker(new URL(...))`). */
  createWorker: () => KokoroWorkerLike;
  /** Cache probe; default {@link probeKokoroCached}. */
  probeCached?: (modelId: string) => Promise<boolean>;
  modelId?: string;
  /** Default voice for syntheses that omit one. */
  voice?: string;
}

interface Pending {
  resolve: (blob: Blob) => void;
  reject: (err: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

let synthCounter = 0;

/**
 * Observable Kokoro TTS controller. The settings component subscribes to its
 * download/cache state; the TTS router calls {@link KokoroController.getSynthesizer}
 * to voice replies. Construct once (via {@link createKokoroController}); tests
 * drive it with a fake worker.
 */
export class KokoroController {
  private readonly deps: KokoroControllerDeps;
  private readonly modelId: string;
  private readonly voice?: string;

  private state: KokoroStatusState;
  private worker: KokoroWorkerLike | null = null;
  private readonly listeners = new Set<(s: KokoroStatusState) => void>();
  private readonly pending = new Map<string, Pending>();

  constructor(deps: KokoroControllerDeps) {
    this.deps = deps;
    this.modelId = deps.modelId ?? DEFAULT_KOKORO_MODEL;
    this.voice = deps.voice;
    this.state = initialKokoroStatus(this.modelId);
  }

  getState(): KokoroStatusState {
    return this.state;
  }

  subscribe(listener: (state: KokoroStatusState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Probe the cache so a returning user immediately sees 'cached/ready'. */
  async init(): Promise<void> {
    const probe = this.deps.probeCached ?? probeKokoroCached;
    const cached = await probe(this.modelId);
    if (this.state.phase === "unloaded") this.set({ ...this.state, cached });
  }

  /**
   * Begin the deliberate model download (spawns the worker, posts load and
   * streams progress). Idempotent while downloading/ready.
   */
  load(): void {
    if (this.state.phase === "downloading" || this.state.phase === "ready") return;
    const w = this.ensureWorker();
    this.set({
      ...initialKokoroStatus(this.modelId),
      phase: "downloading",
      cached: this.state.cached,
    });
    this.post(w, { type: "load", modelId: this.modelId });
  }

  /** Skip/abort the download: terminate the worker, route voice to Web Speech. */
  cancel(): void {
    this.rejectAll(new Error("Kokoro canceled"));
    this.killWorker();
    this.set({ ...this.state, phase: "canceled" });
  }

  /** Tear down: terminate the worker, reject pending syntheses, drop listeners. */
  destroy(): void {
    this.rejectAll(new Error("Kokoro destroyed"));
    this.killWorker();
    this.listeners.clear();
  }

  /**
   * The {@link ClipSynthesizer} the TTS router plugs into
   * `TtsRouterDeps.kokoroSynthesize`. Bound to this controller.
   */
  getSynthesizer(): ClipSynthesizer {
    return (text, signal) => this.synthesize(text, signal);
  }

  /** A ready-made `{ kokoroSynthesize }` fragment for the router deps. */
  toRouterDeps(): { kokoroSynthesize: ClipSynthesizer } {
    return { kokoroSynthesize: this.getSynthesizer() };
  }

  /**
   * Synthesize `text` to a WAV Blob via the worker. Ensures the model is
   * loading/ready, correlates the response by id, and honors the AbortSignal
   * (barge-in) by rejecting + dropping the pending request. Rejects on a load or
   * synthesis failure so the router falls back to Web Speech.
   */
  synthesize(text: string, signal: AbortSignal): Promise<Blob> {
    if (signal.aborted) {
      return Promise.reject(new Error("Kokoro synthesis aborted before start"));
    }
    const w = this.ensureWorker();
    // Kick off the model load (streams progress) if it hasn't started; the
    // engine's load is idempotent so a concurrent synthesize shares it.
    if (this.state.phase === "unloaded" || this.state.phase === "canceled") {
      this.load();
    }

    const id = `k${++synthCounter}`;
    return new Promise<Blob>((resolve, reject) => {
      const onAbort = () => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        reject(new Error("Kokoro synthesis aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, signal, onAbort });
      this.post(w, {
        type: "synthesize",
        id,
        text,
        voice: this.voice,
      });
    });
  }

  // --- internals -----------------------------------------------------------

  private ensureWorker(): KokoroWorkerLike {
    if (this.worker) return this.worker;
    const w = this.deps.createWorker();
    const onMessage = (ev: MessageEvent): void => this.handleMessage(ev.data);
    if (w.addEventListener) w.addEventListener("message", onMessage);
    else w.onmessage = onMessage;
    this.worker = w;
    return w;
  }

  private handleMessage(msg: KokoroResponse): void {
    // Resolve/reject any pending synthesis first.
    if (msg.type === "audio") {
      this.settlePending(msg.id, (p) => p.resolve(msg.blob));
    } else if (msg.type === "error" && msg.id !== undefined) {
      const err = new Error(msg.message);
      this.settlePending(msg.id, (p) => p.reject(err));
    }
    // Fold load-relevant messages into the download/cache state.
    this.set(kokoroStatusReducer(this.state, msg));
  }

  private settlePending(id: string, settle: (p: Pending) => void): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.signal.removeEventListener("abort", p.onAbort);
    settle(p);
  }

  private rejectAll(err: unknown): void {
    for (const [id, p] of this.pending) {
      p.signal.removeEventListener("abort", p.onAbort);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private killWorker(): void {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // ignore
      }
      this.worker = null;
    }
  }

  private post(w: KokoroWorkerLike, msg: KokoroRequest): void {
    w.postMessage(msg);
  }

  private set(next: KokoroStatusState): void {
    this.state = next;
    for (const l of this.listeners) l(this.state);
  }
}

/**
 * Spawn the real Kokoro worker (client-only; never runs during SSR/tests).
 * Kept here so both the controller default and the status component share it.
 */
export function spawnKokoroWorker(): KokoroWorkerLike {
  return new Worker(new URL("./kokoro-worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as KokoroWorkerLike;
}

/** Convenience factory mirroring the other engine factories. */
export function createKokoroController(
  deps: KokoroControllerDeps = { createWorker: spawnKokoroWorker },
): KokoroController {
  return new KokoroController(deps);
}
