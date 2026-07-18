// Hands-free voice activity detection (VAD) built on Silero + ONNX via
// `@ricky0123/vad-web`. When enabled, the mic listens continuously: the model
// auto-detects when the user STARTS and STOPS speaking, so a turn begins and
// ends with no button — the counterpart to push-to-talk (they are mutually
// exclusive input modes, selected in settings).
//
// This wrapper keeps the heavy library at arm's length:
//   - `MicVAD.new` (which pulls in onnxruntime-web + the Silero worklet/model)
//     is created LAZILY on `start()` and behind an INJECTABLE `createMicVAD`
//     seam, so the module imports light and the whole controller is headlessly
//     testable under jsdom with a fake VAD — no ONNX, no worklet, no real mic.
//   - The Silero model + worklet + ORT wasm are SELF-HOSTED under `/vad/`
//     (see scripts/setup-vad-assets.mjs) so they resolve under the app's COEP
//     headers instead of being blocked as cross-origin.
//   - On speech-end the captured Float32Array (16 kHz mono) is WAV-encoded into
//     a Blob the STT layer (`/api/transcribe`) can post directly.
//   - Barge-in: if the user starts speaking while the FACE is speaking, the
//     controller fires `onBargeIn` so the orchestrator can cancel TTS + the
//     in-flight chat.

import { resumeAudio as defaultResumeAudio } from "./context";

/** Which Silero model to run. `legacy` is the library default; `v5` is newer. */
export type VadModel = "v5" | "legacy";

/** The VAD's own lifecycle (distinct from the conversation lifecycle). */
export type VadState =
  | "idle" // not listening
  | "loading" // fetching model/worklet, building the graph
  | "listening" // mic open, waiting for speech
  | "speech" // the user is currently speaking
  | "error"; // failed to load / start

/** Default Silero model (matches the library's own default). */
export const DEFAULT_VAD_MODEL: VadModel = "legacy";
/** Self-hosted asset root (see scripts/setup-vad-assets.mjs + next headers). */
export const DEFAULT_VAD_ASSET_PATH = "/vad/";
/** VAD emits 16 kHz mono audio segments. */
export const VAD_SAMPLE_RATE = 16_000;

// Conservative tuning defaults. `minSpeechMs` is the debounce that keeps a brief
// cough/click from opening a turn; `redemptionMs` lets a short pause mid-sentence
// not prematurely end one; `preSpeechPadMs` prepends lead-in so the first phoneme
// isn't clipped. (The library takes ms and converts to frames internally.)
export const DEFAULT_POSITIVE_SPEECH_THRESHOLD = 0.5;
export const DEFAULT_NEGATIVE_SPEECH_THRESHOLD = 0.35;
export const DEFAULT_MIN_SPEECH_MS = 400;
export const DEFAULT_REDEMPTION_MS = 1400;
export const DEFAULT_PRE_SPEECH_PAD_MS = 800;

/** A captured utterance, ready to hand to STT. */
export interface VadSegment {
  /** Raw 16 kHz mono samples in [-1, 1]. */
  audio: Float32Array;
  /** Sample rate of `audio` (always {@link VAD_SAMPLE_RATE}). */
  sampleRate: number;
  /** WAV-encoded blob (audio/wav) suitable for posting to `/api/transcribe`. */
  blob: Blob;
  /** Utterance length in milliseconds. */
  durationMs: number;
}

/** Lifecycle callbacks the orchestrator wires to emotion + STT + barge-in. */
export interface VadCallbacks {
  /** User started speaking — orchestrator sets lifecycle 'listening' (alert). */
  onSpeechStart?: () => void;
  /** A complete utterance was captured — hand `segment` to the STT layer. */
  onSpeechEnd?: (segment: VadSegment) => void;
  /** Speech too short to count (below `minSpeechFrames`) — a debounced noise. */
  onMisfire?: () => void;
  /** User spoke WHILE the face was speaking — cancel TTS + the in-flight chat. */
  onBargeIn?: () => void;
  /** A load/encode failure surfaced out-of-band (start() also rejects on load). */
  onError?: (err: unknown) => void;
  /** State transitions (for UI indicators). */
  onStateChange?: (state: VadState) => void;
}

/** Detector tuning (Silero thresholds + ms budgets). */
export interface VadTuning {
  positiveSpeechThreshold?: number;
  negativeSpeechThreshold?: number;
  /** Debounce: a segment shorter than this many ms is a misfire, not a turn. */
  minSpeechMs?: number;
  /** Grace period after speech dips before ending a turn (bridges short pauses). */
  redemptionMs?: number;
  /** Lead-in prepended to the captured segment so the first phoneme isn't clipped. */
  preSpeechPadMs?: number;
}

export interface VadOptions extends VadTuning {
  /** The SHARED mic stream (or a getter). Reuses the recorder's stream. */
  stream?: MediaStream | (() => MediaStream | Promise<MediaStream>);
  /** The SHARED AudioContext, so the worklet taps the same graph. */
  audioContext?: AudioContext;
  model?: VadModel;
  /** Root for the worklet + Silero .onnx (self-hosted; default `/vad/`). */
  baseAssetPath?: string;
  /** Root for the onnxruntime-web wasm (self-hosted; default `/vad/`). */
  onnxWASMBasePath?: string;
}

/** The minimal surface of `MicVAD` this wrapper drives. */
export interface MicVADLike {
  start(): Promise<void> | void;
  pause(): Promise<void> | void;
  destroy(): Promise<void> | void;
  readonly listening?: boolean;
}

/** The config passed to the (injectable) MicVAD factory. */
export interface MicVADConfig {
  onSpeechStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void | Promise<void>;
  onVADMisfire: () => void;
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  minSpeechMs: number;
  redemptionMs: number;
  preSpeechPadMs: number;
  model: VadModel;
  baseAssetPath: string;
  onnxWASMBasePath: string;
  audioContext?: AudioContext;
  getStream?: () => Promise<MediaStream>;
  /** We control start/pause ourselves, so the VAD must NOT auto-start on load. */
  startOnLoad: boolean;
}

/** Injectable heavy primitives (defaults lazily import the real library). */
export interface VadDeps {
  createMicVAD?: (config: MicVADConfig) => Promise<MicVADLike>;
  encodeWAV?: (
    samples: Float32Array,
    sampleRate: number,
  ) => ArrayBuffer | Promise<ArrayBuffer>;
  resumeAudio?: () => Promise<unknown>;
}

/** Default factory: lazily import the library so ONNX only loads when used. */
async function defaultCreateMicVAD(config: MicVADConfig): Promise<MicVADLike> {
  const mod = await import("@ricky0123/vad-web");
  return mod.MicVAD.new({
    onSpeechStart: config.onSpeechStart,
    onSpeechEnd: config.onSpeechEnd,
    onVADMisfire: config.onVADMisfire,
    positiveSpeechThreshold: config.positiveSpeechThreshold,
    negativeSpeechThreshold: config.negativeSpeechThreshold,
    minSpeechMs: config.minSpeechMs,
    redemptionMs: config.redemptionMs,
    preSpeechPadMs: config.preSpeechPadMs,
    model: config.model,
    baseAssetPath: config.baseAssetPath,
    onnxWASMBasePath: config.onnxWASMBasePath,
    startOnLoad: config.startOnLoad,
    ...(config.audioContext ? { audioContext: config.audioContext } : {}),
    ...(config.getStream ? { getStream: config.getStream } : {}),
  });
}

/** Default WAV encoder: reuses the library's util (16-bit PCM). */
async function defaultEncodeWAV(
  samples: Float32Array,
  sampleRate: number,
): Promise<ArrayBuffer> {
  const mod = await import("@ricky0123/vad-web");
  // encodeWAV(samples, format=1 (PCM), sampleRate, numChannels=1, bitDepth=16)
  return mod.utils.encodeWAV(samples, 1, sampleRate, 1, 16);
}

/**
 * Hands-free VAD controller. Construct once with callbacks + the shared
 * stream/context, then `start()` to begin listening and `pause()`/`destroy()`
 * to stop. Mutually exclusive with push-to-talk — the orchestrator runs one or
 * the other based on the selected input mode.
 */
export class VadController {
  private readonly callbacks: VadCallbacks;
  private readonly options: VadOptions;
  private readonly deps: VadDeps;

  private state: VadState = "idle";
  private vad: MicVADLike | null = null;
  private loadPromise: Promise<MicVADLike> | null = null;
  private disposed = false;
  /** Is the FACE currently speaking? Governs whether speech-start is a barge-in. */
  private faceSpeaking = false;

  constructor(
    callbacks: VadCallbacks = {},
    options: VadOptions = {},
    deps: VadDeps = {},
  ) {
    this.callbacks = callbacks;
    this.options = options;
    this.deps = deps;
  }

  getState(): VadState {
    return this.state;
  }

  /** True while the mic is open (listening or actively hearing speech). */
  get active(): boolean {
    return this.state === "listening" || this.state === "speech";
  }

  private setState(next: VadState): void {
    if (this.state === next) return;
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  /**
   * Tell the controller whether the face is currently speaking. When true, a
   * detected speech-start is treated as a barge-in (fires `onBargeIn`).
   */
  setFaceSpeaking(speaking: boolean): void {
    this.faceSpeaking = speaking;
  }

  private resolveGetStream(): (() => Promise<MediaStream>) | undefined {
    const s = this.options.stream;
    if (!s) return undefined;
    if (typeof s === "function") return () => Promise.resolve(s());
    return () => Promise.resolve(s);
  }

  private buildConfig(): MicVADConfig {
    return {
      onSpeechStart: () => this.handleSpeechStart(),
      onSpeechEnd: (audio) => this.handleSpeechEnd(audio),
      onVADMisfire: () => this.handleMisfire(),
      positiveSpeechThreshold:
        this.options.positiveSpeechThreshold ??
        DEFAULT_POSITIVE_SPEECH_THRESHOLD,
      negativeSpeechThreshold:
        this.options.negativeSpeechThreshold ??
        DEFAULT_NEGATIVE_SPEECH_THRESHOLD,
      minSpeechMs: this.options.minSpeechMs ?? DEFAULT_MIN_SPEECH_MS,
      redemptionMs: this.options.redemptionMs ?? DEFAULT_REDEMPTION_MS,
      preSpeechPadMs: this.options.preSpeechPadMs ?? DEFAULT_PRE_SPEECH_PAD_MS,
      model: this.options.model ?? DEFAULT_VAD_MODEL,
      baseAssetPath: this.options.baseAssetPath ?? DEFAULT_VAD_ASSET_PATH,
      onnxWASMBasePath: this.options.onnxWASMBasePath ?? DEFAULT_VAD_ASSET_PATH,
      audioContext: this.options.audioContext,
      getStream: this.resolveGetStream(),
      startOnLoad: false,
    };
  }

  private handleSpeechStart(): void {
    if (this.disposed) return;
    this.setState("speech");
    // Speaking over the face is a barge-in — cancel TTS + the in-flight chat.
    if (this.faceSpeaking) this.callbacks.onBargeIn?.();
    this.callbacks.onSpeechStart?.();
  }

  private async handleSpeechEnd(audio: Float32Array): Promise<void> {
    if (this.disposed) return;
    // Back to waiting for the next utterance.
    if (this.state === "speech") this.setState("listening");
    const encode = this.deps.encodeWAV ?? defaultEncodeWAV;
    try {
      const buffer = await encode(audio, VAD_SAMPLE_RATE);
      const blob = new Blob([buffer], { type: "audio/wav" });
      const durationMs = (audio.length / VAD_SAMPLE_RATE) * 1000;
      this.callbacks.onSpeechEnd?.({
        audio,
        sampleRate: VAD_SAMPLE_RATE,
        blob,
        durationMs,
      });
    } catch (err) {
      // Encoding failed out-of-band; surface it without crashing the loop.
      this.callbacks.onError?.(err);
    }
  }

  private handleMisfire(): void {
    if (this.disposed) return;
    if (this.state === "speech") this.setState("listening");
    this.callbacks.onMisfire?.();
  }

  private ensureLoaded(): Promise<MicVADLike> {
    if (this.vad) return Promise.resolve(this.vad);
    if (this.loadPromise) return this.loadPromise;
    this.setState("loading");
    const create = this.deps.createMicVAD ?? defaultCreateMicVAD;
    this.loadPromise = create(this.buildConfig())
      .then((vad) => {
        this.vad = vad;
        return vad;
      })
      .catch((err) => {
        this.setState("error");
        throw err;
      })
      .finally(() => {
        this.loadPromise = null;
      });
    return this.loadPromise;
  }

  /**
   * Begin hands-free listening. Loads the model on first use (behind a user
   * gesture so the shared AudioContext can resume). Rejects if loading fails
   * (and parks the controller in the 'error' state); safe to call repeatedly.
   */
  async start(): Promise<void> {
    if (this.disposed) return;
    if (this.active) return;

    // Unlock the shared AudioContext (autoplay policy) — must be in a gesture.
    try {
      await (this.deps.resumeAudio ?? defaultResumeAudio)();
    } catch {
      // Non-fatal — a failed resume just means silent playback until the next
      // gesture; detection itself is unaffected.
    }

    const vad = await this.ensureLoaded();
    if (this.disposed) return;
    await vad.start();
    this.setState("listening");
  }

  /** Stop listening but keep the model loaded (a later start() is instant). */
  async pause(): Promise<void> {
    if (!this.vad) {
      this.setState("idle");
      return;
    }
    try {
      await this.vad.pause();
    } finally {
      this.setState("idle");
    }
  }

  /** Tear down the VAD entirely and release its graph. */
  async destroy(): Promise<void> {
    this.disposed = true;
    const vad = this.vad;
    this.vad = null;
    this.loadPromise = null;
    if (vad) {
      try {
        await vad.destroy();
      } catch {
        // Already torn down — ignore.
      }
    }
    this.setState("idle");
  }
}

/** Convenience factory mirroring `createRecorder`. */
export function createVad(
  callbacks?: VadCallbacks,
  options?: VadOptions,
  deps?: VadDeps,
): VadController {
  return new VadController(callbacks, options, deps);
}
