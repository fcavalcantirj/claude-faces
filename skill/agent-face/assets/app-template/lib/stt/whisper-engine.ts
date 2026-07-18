// In-browser Whisper transcription engine (transformers.js).
//
// This is the headlessly-testable CORE behind the Web Worker
// (see ./whisper-worker). It owns:
//   - loading the ASR pipeline with a WebGPU-first / WASM-fallback strategy,
//   - keeping that pipeline RESIDENT so repeated transcriptions never
//     re-download the ~150 MB model,
//   - decoding webm/opus clips to 16 kHz mono PCM before inference,
//   - surfacing an OOM / runtime failure as a typed error that signals the STT
//     layer to fall back to hosted transcription.
//
// Every heavy/browser primitive (the transformers.js `pipeline`, WebGPU
// detection, audio decode) is INJECTED via `WhisperEngineDeps`, so the whole
// engine runs under jsdom with fakes — no model download, no WebGPU, no
// AudioContext. The defaults lazily import the real dependencies so the module
// stays light until actually used.

/** Backend the ONNX runtime executes on. */
export type WhisperBackend = "webgpu" | "wasm";

/** Default multilingual model — small enough for a first-run browser download. */
export const DEFAULT_WHISPER_MODEL = "Xenova/whisper-base";

/** Whisper expects 16 kHz mono audio. */
export const WHISPER_SAMPLE_RATE = 16_000;

/** Normalized model-load progress (from transformers.js `progress_callback`). */
export interface WhisperProgress {
  /** e.g. "initiate" | "download" | "progress" | "done" | "ready". */
  status: string;
  /** The file being fetched (a shard/weights name), when known. */
  file?: string;
  /** 0..100 download percentage, when known. */
  progress?: number;
  loaded?: number;
  total?: number;
}

/** Result of a single transcription. */
export interface WhisperResult {
  text: string;
  backend: WhisperBackend;
  /** Inference wall-clock (ms), excluding model load. */
  durationMs: number;
}

/** Audio to transcribe: pre-decoded 16 kHz mono PCM, or a raw clip to decode. */
export type WhisperInput = Float32Array | { blob: Blob };

export interface TranscribeOptions {
  /** BCP-47/ISO language hint (e.g. "en"); omit for auto-detect. */
  language?: string;
}

/** The minimal call shape of a transformers.js ASR pipeline. */
export interface TransformersPipeline {
  (
    audio: Float32Array,
    options?: Record<string, unknown>,
  ): Promise<{ text?: string } | Array<{ text?: string }>>;
}

export interface CreatePipelineArgs {
  task: "automatic-speech-recognition";
  modelId: string;
  device: WhisperBackend;
  onProgress?: (p: WhisperProgress) => void;
}

/** Injectable heavy primitives (defaults lazily import the real deps). */
export interface WhisperEngineDeps {
  /** Build an ASR pipeline on the given device. Default: transformers.js. */
  createPipeline?: (args: CreatePipelineArgs) => Promise<TransformersPipeline>;
  /** Resolve true when a usable WebGPU adapter exists. Default: navigator.gpu. */
  detectWebGPU?: () => Promise<boolean>;
  /** Decode a clip Blob to 16 kHz mono PCM. Default: OfflineAudioContext. */
  decodeAudio?: (blob: Blob) => Promise<Float32Array>;
  /** Monotonic clock (ms). Default: performance.now / Date.now. */
  now?: () => number;
}

export interface WhisperEngineOptions {
  /** Model to load (default {@link DEFAULT_WHISPER_MODEL}). */
  modelId?: string;
}

/** Typed engine failure; `fallbackToHosted` tells the STT layer to route hosted. */
export class WhisperError extends Error {
  readonly fallbackToHosted: boolean;
  readonly cause?: unknown;

  constructor(message: string, fallbackToHosted: boolean, cause?: unknown) {
    super(message);
    this.name = "WhisperError";
    this.fallbackToHosted = fallbackToHosted;
    this.cause = cause;
    Object.setPrototypeOf(this, WhisperError.prototype);
  }
}

function clock(deps: WhisperEngineDeps): number {
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

/** Default pipeline factory: lazily import transformers.js and build the ASR pipeline. */
async function defaultCreatePipeline(
  args: CreatePipelineArgs,
): Promise<TransformersPipeline> {
  const mod = await import("@huggingface/transformers");
  const pipe = await mod.pipeline(args.task, args.modelId, {
    device: args.device,
    progress_callback: args.onProgress
      ? (p: unknown) => args.onProgress?.(normalizeProgress(p))
      : undefined,
  });
  return pipe as unknown as TransformersPipeline;
}

/** Default decode: OfflineAudioContext render → 16 kHz mono Float32Array. */
async function defaultDecodeAudio(blob: Blob): Promise<Float32Array> {
  const g = globalThis as {
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const OfflineCtor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (!OfflineCtor) {
    throw new WhisperError("No OfflineAudioContext to decode audio", true);
  }
  const bytes = await blob.arrayBuffer();
  // Decode at the clip's native rate first (a 1-frame context is enough to call
  // decodeAudioData), then resample to 16 kHz mono via an offline render.
  const decodeCtx = new OfflineCtor(1, 1, WHISPER_SAMPLE_RATE);
  const decoded = await decodeCtx.decodeAudioData(bytes);
  const frames = Math.max(1, Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE));
  const render = new OfflineCtor(1, frames, WHISPER_SAMPLE_RATE);
  const src = render.createBufferSource();
  src.buffer = decoded;
  src.connect(render.destination);
  src.start();
  const out = await render.startRendering();
  return out.getChannelData(0).slice();
}

/** Normalize a transformers.js progress event into {@link WhisperProgress}. */
export function normalizeProgress(p: unknown): WhisperProgress {
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
 * Resident Whisper transcriber. Construct once; `load()` builds the pipeline
 * (WebGPU first, WASM fallback) and later calls reuse it. `transcribe()` accepts
 * pre-decoded PCM or a clip Blob (decoded to 16 kHz mono first).
 */
export class WhisperEngine {
  readonly modelId: string;
  private readonly deps: WhisperEngineDeps;

  private pipeline: TransformersPipeline | null = null;
  private backend: WhisperBackend | null = null;
  private loadPromise: Promise<WhisperBackend> | null = null;

  constructor(options: WhisperEngineOptions = {}, deps: WhisperEngineDeps = {}) {
    this.modelId = options.modelId ?? DEFAULT_WHISPER_MODEL;
    this.deps = deps;
  }

  /** The backend once loaded, else null. */
  getBackend(): WhisperBackend | null {
    return this.backend;
  }

  /** True once the pipeline is resident (no re-download on the next call). */
  isReady(): boolean {
    return this.pipeline !== null;
  }

  /**
   * Load (once) the ASR pipeline. Tries WebGPU when an adapter is available and
   * transparently falls back to WASM on failure (or when WebGPU is absent).
   * Returns the chosen backend; concurrent/repeat calls share one load.
   */
  load(
    onProgress?: (p: WhisperProgress) => void,
    modelIdOverride?: string,
  ): Promise<WhisperBackend> {
    if (this.pipeline && this.backend) return Promise.resolve(this.backend);
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
    onProgress?: (p: WhisperProgress) => void,
    modelIdOverride?: string,
  ): Promise<WhisperBackend> {
    const createPipeline = this.deps.createPipeline ?? defaultCreatePipeline;
    const detectWebGPU = this.deps.detectWebGPU ?? defaultDetectWebGPU;
    const modelId = modelIdOverride ?? this.modelId;

    const wantWebGPU = await detectWebGPU();
    const order: WhisperBackend[] = wantWebGPU ? ["webgpu", "wasm"] : ["wasm"];

    let lastErr: unknown;
    for (const device of order) {
      try {
        const pipe = await createPipeline({
          task: "automatic-speech-recognition",
          modelId,
          device,
          onProgress,
        });
        this.pipeline = pipe;
        return device;
      } catch (err) {
        // WebGPU init can fail on some drivers/OOM — try the next backend.
        lastErr = err;
      }
    }
    throw new WhisperError(
      `Failed to load Whisper model "${modelId}"`,
      true,
      lastErr,
    );
  }

  /**
   * Transcribe a clip. Ensures the pipeline is resident, decodes a Blob input to
   * 16 kHz mono PCM if needed, and runs inference. Runtime/OOM failures surface
   * as a {@link WhisperError} with `fallbackToHosted = true`.
   */
  async transcribe(
    input: WhisperInput,
    options: TranscribeOptions = {},
  ): Promise<WhisperResult> {
    const backend = await this.load();
    const pipe = this.pipeline;
    if (!pipe) throw new WhisperError("Whisper pipeline is not loaded", true);

    const audio =
      input instanceof Float32Array ? input : await this.decode(input.blob);

    const start = clock(this.deps);
    try {
      const raw = await pipe(audio, {
        ...(options.language ? { language: options.language } : {}),
      });
      const text = extractText(raw);
      return { text, backend, durationMs: clock(this.deps) - start };
    } catch (err) {
      if (err instanceof WhisperError) throw err;
      throw new WhisperError(
        "Whisper inference failed (likely OOM) — falling back to hosted STT",
        true,
        err,
      );
    }
  }

  private async decode(blob: Blob): Promise<Float32Array> {
    const decodeAudio = this.deps.decodeAudio ?? defaultDecodeAudio;
    try {
      return await decodeAudio(blob);
    } catch (err) {
      if (err instanceof WhisperError) throw err;
      throw new WhisperError("Failed to decode audio clip", true, err);
    }
  }

  /** Release the resident pipeline (a later load() rebuilds it). */
  dispose(): void {
    this.pipeline = null;
    this.backend = null;
    this.loadPromise = null;
  }
}

function extractText(raw: { text?: string } | Array<{ text?: string }>): string {
  if (Array.isArray(raw)) {
    return raw
      .map((r) => r?.text ?? "")
      .join(" ")
      .trim();
  }
  return (raw?.text ?? "").trim();
}
