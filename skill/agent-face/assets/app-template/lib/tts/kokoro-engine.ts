// All-local Kokoro-82M text-to-speech engine (kokoro-js on WebGPU / WASM).
//
// This is the headlessly-testable CORE behind the Kokoro Web Worker
// (see ./kokoro-worker). It owns:
//   - loading the Kokoro-82M ONNX model with a WebGPU-first / WASM-fallback
//     strategy (WebGPU uses fp32; the CPU/WASM path uses a quantized q8 build so
//     the download stays small and inference is usable without a GPU),
//   - keeping that model RESIDENT so repeated syntheses never re-download,
//   - synthesizing a reply to a WAV `Blob` that plays through an <audio> element
//     on the shared AudioContext — so the TTS router taps it with the REAL FFT
//     analyser (mouthSource 'analyser'), exactly like the OpenAI TTS path,
//   - surfacing a load/inference failure as a typed error that tells the router
//     to fall back to Web Speech.
//
// Every heavy/browser primitive (the kokoro-js model, WebGPU detection) is
// INJECTED via `KokoroEngineDeps`, so the whole engine runs under jsdom with
// fakes — no model download, no WebGPU. The defaults lazily import the real
// dependency so the module stays light until actually used.

/** Backend the ONNX runtime executes on. */
export type KokoroBackend = "webgpu" | "wasm";

/** kokoro-js quantization levels. */
export type KokoroDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";

/** Default Kokoro-82M ONNX build on the Hugging Face Hub. */
export const DEFAULT_KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Default voice (kokoro-js ships `af_heart` as the reference voice). */
export const DEFAULT_KOKORO_VOICE = "af_heart";

/**
 * Per-backend dtype: WebGPU has the memory budget for full-precision fp32, while
 * the CPU/WASM path uses the q8 build (~86 MB vs ~326 MB) so a GPU-less machine
 * still gets a small download and workable latency.
 */
export function dtypeForBackend(backend: KokoroBackend): KokoroDtype {
  return backend === "webgpu" ? "fp32" : "q8";
}

/** Normalized model-load progress (from the kokoro-js progress_callback). */
export interface KokoroProgress {
  /** e.g. "initiate" | "download" | "progress" | "done" | "ready". */
  status: string;
  /** The file being fetched (a shard/weights name), when known. */
  file?: string;
  /** 0..100 download percentage, when known. */
  progress?: number;
  loaded?: number;
  total?: number;
}

export interface KokoroSynthesizeOptions {
  /** Voice id (default {@link DEFAULT_KOKORO_VOICE}). */
  voice?: string;
  /** Speaking speed (default 1). */
  speed?: number;
}

/** Result of a single synthesis. */
export interface KokoroResult {
  /** WAV audio, playable through an <audio> element on the shared AudioContext. */
  blob: Blob;
  backend: KokoroBackend;
  /** Synthesis wall-clock (ms), excluding model load. */
  durationMs: number;
}

/** The minimal call shape of a kokoro-js model instance. */
export interface KokoroModel {
  generate(
    text: string,
    options?: { voice?: string; speed?: number },
  ): Promise<{ toBlob(): Blob }>;
}

export interface CreateKokoroArgs {
  modelId: string;
  dtype: KokoroDtype;
  device: KokoroBackend;
  onProgress?: (p: KokoroProgress) => void;
}

/** Injectable heavy primitives (defaults lazily import the real deps). */
export interface KokoroEngineDeps {
  /** Build a Kokoro model on the given device. Default: kokoro-js. */
  createModel?: (args: CreateKokoroArgs) => Promise<KokoroModel>;
  /** Resolve true when a usable WebGPU adapter exists. Default: navigator.gpu. */
  detectWebGPU?: () => Promise<boolean>;
  /** Monotonic clock (ms). Default: performance.now / Date.now. */
  now?: () => number;
}

export interface KokoroEngineOptions {
  /** Model to load (default {@link DEFAULT_KOKORO_MODEL}). */
  modelId?: string;
  /** Default voice for syntheses that omit one. */
  voice?: string;
}

/** Typed engine failure; `fallbackToWebSpeech` tells the router to route Web Speech. */
export class KokoroError extends Error {
  readonly fallbackToWebSpeech: boolean;
  readonly cause?: unknown;

  constructor(message: string, fallbackToWebSpeech: boolean, cause?: unknown) {
    super(message);
    this.name = "KokoroError";
    this.fallbackToWebSpeech = fallbackToWebSpeech;
    this.cause = cause;
    Object.setPrototypeOf(this, KokoroError.prototype);
  }
}

function clock(deps: KokoroEngineDeps): number {
  if (deps.now) return deps.now();
  if (typeof performance !== "undefined") return performance.now();
  return Date.now();
}

/** Default WebGPU probe: an adapter must actually be grantable, not just present. */
async function defaultDetectWebGPU(): Promise<boolean> {
  try {
    const gpu = (globalThis as { navigator?: { gpu?: { requestAdapter?: () => Promise<unknown> } } })
      .navigator?.gpu;
    if (!gpu?.requestAdapter) return false;
    const adapter = await gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

/** Default model factory: lazily import kokoro-js and load the Kokoro-82M model. */
async function defaultCreateModel(args: CreateKokoroArgs): Promise<KokoroModel> {
  const mod = await import("kokoro-js");
  const tts = await mod.KokoroTTS.from_pretrained(args.modelId, {
    dtype: args.dtype,
    device: args.device,
    progress_callback: args.onProgress
      ? (p: unknown) => args.onProgress?.(normalizeProgress(p))
      : undefined,
  });
  return tts as unknown as KokoroModel;
}

/** Normalize a kokoro-js/transformers progress event into {@link KokoroProgress}. */
export function normalizeProgress(p: unknown): KokoroProgress {
  const o = (p ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return {
    status: typeof o.status === "string" ? o.status : "progress",
    file: typeof o.file === "string" ? o.file : undefined,
    progress: num(o.progress),
    loaded: num(o.loaded),
    total: num(o.total),
  };
}

/**
 * Resident Kokoro synthesizer. Construct once; `load()` builds the model
 * (WebGPU first, WASM fallback) and later calls reuse it. `synthesize()`
 * returns a WAV Blob. Runtime/OOM failures surface as a {@link KokoroError}
 * with `fallbackToWebSpeech = true`.
 */
export class KokoroEngine {
  readonly modelId: string;
  private readonly deps: KokoroEngineDeps;
  private readonly defaultVoice: string;

  private model: KokoroModel | null = null;
  private backend: KokoroBackend | null = null;
  private loadPromise: Promise<KokoroBackend> | null = null;

  constructor(options: KokoroEngineOptions = {}, deps: KokoroEngineDeps = {}) {
    this.modelId = options.modelId ?? DEFAULT_KOKORO_MODEL;
    this.defaultVoice = options.voice ?? DEFAULT_KOKORO_VOICE;
    this.deps = deps;
  }

  /** The backend once loaded, else null. */
  getBackend(): KokoroBackend | null {
    return this.backend;
  }

  /** True once the model is resident (no re-download on the next call). */
  isReady(): boolean {
    return this.model !== null;
  }

  /**
   * Load (once) the Kokoro model. Tries WebGPU when an adapter is available and
   * transparently falls back to WASM on failure (or when WebGPU is absent).
   * Returns the chosen backend; concurrent/repeat calls share one load.
   */
  load(
    onProgress?: (p: KokoroProgress) => void,
    modelIdOverride?: string,
  ): Promise<KokoroBackend> {
    if (this.model && this.backend) return Promise.resolve(this.backend);
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadInternal(onProgress, modelIdOverride)
      .then((backend) => {
        this.backend = backend;
        return backend;
      })
      .finally(() => {
        this.loadPromise = null;
      });
    return this.loadPromise;
  }

  private async loadInternal(
    onProgress?: (p: KokoroProgress) => void,
    modelIdOverride?: string,
  ): Promise<KokoroBackend> {
    const createModel = this.deps.createModel ?? defaultCreateModel;
    const detectWebGPU = this.deps.detectWebGPU ?? defaultDetectWebGPU;
    const modelId = modelIdOverride ?? this.modelId;

    const wantWebGPU = await detectWebGPU();
    const order: KokoroBackend[] = wantWebGPU ? ["webgpu", "wasm"] : ["wasm"];

    let lastErr: unknown;
    for (const device of order) {
      try {
        const model = await createModel({
          modelId,
          dtype: dtypeForBackend(device),
          device,
          onProgress,
        });
        this.model = model;
        return device;
      } catch (err) {
        // WebGPU init can fail on some drivers/OOM — try the next backend.
        lastErr = err;
      }
    }
    throw new KokoroError(
      `Failed to load Kokoro model "${modelId}"`,
      true,
      lastErr,
    );
  }

  /**
   * Synthesize `text` to a WAV Blob. Ensures the model is resident, then runs
   * generation. Failures surface as a {@link KokoroError} with
   * `fallbackToWebSpeech = true`.
   */
  async synthesize(
    text: string,
    options: KokoroSynthesizeOptions = {},
  ): Promise<KokoroResult> {
    const clean = (text ?? "").trim();
    if (!clean) {
      throw new KokoroError("Kokoro synthesize called with empty text", false);
    }
    const backend = await this.load();
    const model = this.model;
    if (!model) throw new KokoroError("Kokoro model is not loaded", true);

    const start = clock(this.deps);
    try {
      const audio = await model.generate(clean, {
        voice: options.voice ?? this.defaultVoice,
        speed: options.speed ?? 1,
      });
      const blob = audio.toBlob();
      return { blob, backend, durationMs: clock(this.deps) - start };
    } catch (err) {
      if (err instanceof KokoroError) throw err;
      throw new KokoroError(
        "Kokoro synthesis failed (likely OOM) — falling back to Web Speech",
        true,
        err,
      );
    }
  }

  /** Release the resident model (a later load() rebuilds it). */
  dispose(): void {
    this.model = null;
    this.backend = null;
    this.loadPromise = null;
  }
}
