// Whisper model download + caching UX — the headlessly-testable CORE.
//
// The in-browser Whisper model is a ~150 MB download, so the first browser-STT
// use must be a DELIBERATE, explained action (not a surprise fetch), and a
// reload must show the model as cached / offline-capable instead of
// re-downloading. This module owns that state without touching React or a real
// Worker:
//   - `modelStatusReducer` folds the worker's progress/ready/error messages
//     into a small state machine (unloaded → downloading → ready | error |
//     canceled), aggregating per-file download percentages into one bar.
//   - `probeModelCached` inspects the browser Cache Storage (where
//     transformers.js persists model shards) to detect an offline-ready model.
//   - `createModelStatusController` is the observable glue the React hook wraps:
//     it spawns the Whisper worker on `download()`, streams progress, and lets
//     `cancel()` terminate the worker and route STT to the hosted fallback.
//
// Every browser primitive (the Worker, Cache Storage) is INJECTED so the whole
// module runs under jsdom with fakes — no worker, no network, no download.

import { DEFAULT_WHISPER_MODEL, type WhisperBackend } from "./whisper-engine";
import type { WhisperResponse } from "./whisper-worker";

/** Lifecycle of the in-browser model. */
export type ModelPhase =
  | "unloaded" // never loaded this session (may still be cached from a prior visit)
  | "downloading" // worker is fetching/initializing the model
  | "ready" // pipeline resident — transcription works, offline-capable
  | "error" // load failed (fallbackToHosted tells the STT layer to route hosted)
  | "canceled"; // user skipped the download → hosted fallback

export interface ModelStatusState {
  phase: ModelPhase;
  /** Aggregate 0..100 download percentage across all model files. */
  progress: number;
  /** Execution backend once ready (WebGPU/WASM); null until then. */
  backend: WhisperBackend | null;
  modelId: string;
  /** True once the model is in Cache Storage (persists across reloads → offline). */
  cached: boolean;
  /** Per-file download progress, keyed by file name (drives the aggregate). */
  files: Record<string, number>;
  /** Human-readable failure, when phase === 'error'. */
  error?: string;
  /** Whether a failure/cancel should route STT to hosted transcription. */
  fallbackToHosted: boolean;
}

/** Fresh, unloaded state for a model (default {@link DEFAULT_WHISPER_MODEL}). */
export function initialModelStatus(
  modelId: string = DEFAULT_WHISPER_MODEL,
): ModelStatusState {
  return {
    phase: "unloaded",
    progress: 0,
    backend: null,
    modelId,
    cached: false,
    files: {},
    fallbackToHosted: false,
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
 * Pure reducer: fold one worker {@link WhisperResponse} into the model status.
 * Ignores transcription `result` messages (those are not a load concern).
 */
export function modelStatusReducer(
  state: ModelStatusState,
  msg: WhisperResponse,
): ModelStatusState {
  switch (msg.type) {
    case "progress": {
      // The first progress event means a real download/init has begun.
      const phase: ModelPhase =
        state.phase === "unloaded" ? "downloading" : state.phase;
      if (!msg.file) {
        // A file-less progress event (rare) still nudges the bar if numeric.
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
      return {
        ...state,
        phase: "error",
        error: msg.message,
        fallbackToHosted: msg.fallbackToHosted,
      };
    case "result":
    default:
      return state;
  }
}

/** A short human-readable status line for the HUD / STT status component. */
export function statusTextFor(state: ModelStatusState): string {
  switch (state.phase) {
    case "ready":
      return `Ready, offline-capable · ${(state.backend ?? "wasm").toUpperCase()}`;
    case "downloading":
      return `Downloading model… ${state.progress}%`;
    case "error":
      return `Model unavailable — using hosted transcription`;
    case "canceled":
      return `Skipped — using hosted transcription`;
    case "unloaded":
    default:
      return state.cached
        ? "Model cached — offline-ready"
        : `Not downloaded (~${estimateModelSizeMb(state.modelId)} MB)`;
  }
}

// Rough on-disk download sizes (MB) for the browser-friendly Whisper builds.
const MODEL_SIZE_MB: Record<string, number> = {
  "Xenova/whisper-tiny": 75,
  "Xenova/whisper-tiny.en": 75,
  "Xenova/whisper-base": 150,
  "Xenova/whisper-base.en": 150,
  "Xenova/whisper-small": 500,
};

/** Estimated download size (MB) so the user can decide before fetching. */
export function estimateModelSizeMb(modelId: string): number {
  return MODEL_SIZE_MB[modelId] ?? 150;
}

// --- Cache Storage probe ----------------------------------------------------

export interface ProbeCacheDeps {
  /** Cache Storage to inspect. Default: globalThis.caches. */
  caches?: CacheStorage;
  /** Cache name transformers.js persists model shards under. */
  cacheName?: string;
}

/** transformers.js default Cache Storage bucket for downloaded model files. */
export const TRANSFORMERS_CACHE_NAME = "transformers-cache";

/**
 * Detect whether the model's files are already in Cache Storage (i.e. a prior
 * visit downloaded them → this reload is offline-ready with no re-download).
 * Never throws: any failure or missing Cache Storage resolves `false`.
 */
export async function probeModelCached(
  modelId: string,
  deps: ProbeCacheDeps = {},
): Promise<boolean> {
  try {
    const store =
      deps.caches ??
      (globalThis as { caches?: CacheStorage }).caches ??
      undefined;
    if (!store) return false;
    const cache = await store.open(deps.cacheName ?? TRANSFORMERS_CACHE_NAME);
    const keys = await cache.keys();
    // The model id (org/name) appears in every shard URL transformers.js caches.
    return keys.some((req) => req.url.includes(modelId));
  } catch {
    return false;
  }
}

// --- Observable controller (React-agnostic) ---------------------------------

/** Minimal Worker surface the controller drives (real Worker satisfies it). */
export interface WhisperWorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  addEventListener?(
    type: "message",
    listener: (ev: MessageEvent) => void,
  ): void;
  onmessage?: ((ev: MessageEvent) => void) | null;
}

export interface ModelStatusControllerDeps {
  /** Spawn the Whisper worker (real: `new Worker(new URL(...))`). */
  createWorker: () => WhisperWorkerLike;
  /** Cache probe; default {@link probeModelCached}. */
  probeCached?: (modelId: string) => Promise<boolean>;
  modelId?: string;
}

export interface ModelStatusController {
  getState(): ModelStatusState;
  subscribe(listener: (state: ModelStatusState) => void): () => void;
  /** Probe the cache so a returning user immediately sees 'cached/ready'. */
  init(): Promise<void>;
  /** Begin the deliberate model download (spawns the worker, posts load). */
  download(): void;
  /** Skip/abort the download: terminate the worker, route STT to hosted. */
  cancel(): void;
  /** Tear down: terminate any worker and drop listeners. */
  destroy(): void;
}

/**
 * Observable state machine wrapping the Whisper worker. The React hook in
 * components/stt-status.tsx subscribes to this via useSyncExternalStore; tests
 * drive it with a fake worker.
 */
export function createModelStatusController(
  deps: ModelStatusControllerDeps,
): ModelStatusController {
  const modelId = deps.modelId ?? DEFAULT_WHISPER_MODEL;
  const probe = deps.probeCached ?? probeModelCached;

  let state = initialModelStatus(modelId);
  let worker: WhisperWorkerLike | null = null;
  const listeners = new Set<(s: ModelStatusState) => void>();

  function set(next: ModelStatusState): void {
    state = next;
    for (const l of listeners) l(state);
  }

  function attach(w: WhisperWorkerLike): void {
    const onMessage = (ev: MessageEvent): void => {
      set(modelStatusReducer(state, ev.data as WhisperResponse));
    };
    if (w.addEventListener) w.addEventListener("message", onMessage);
    else w.onmessage = onMessage;
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async init() {
      const cached = await probe(modelId);
      // Only reflect the cache while still unloaded — never clobber an
      // in-flight download or a ready pipeline.
      if (state.phase === "unloaded") set({ ...state, cached });
    },

    download() {
      if (state.phase === "downloading" || state.phase === "ready") return;
      worker = deps.createWorker();
      attach(worker);
      set({ ...initialModelStatus(modelId), phase: "downloading", cached: state.cached });
      worker.postMessage({ type: "load", modelId });
    },

    cancel() {
      if (worker) {
        worker.terminate();
        worker = null;
      }
      set({ ...state, phase: "canceled", fallbackToHosted: true });
    },

    destroy() {
      if (worker) {
        worker.terminate();
        worker = null;
      }
      listeners.clear();
    },
  };
}
