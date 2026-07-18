// Microphone capture + push-to-talk recording.
//
// Wraps getUserMedia({audio:true}) + MediaRecorder behind a small, headlessly
// testable surface. The browser primitives (getUserMedia, MediaRecorder,
// MediaRecorder.isTypeSupported, AudioContext resume) are all INJECTED via
// `RecorderDeps` so the whole lifecycle can be exercised under jsdom with fakes
// — no real mic, no real MediaRecorder.
//
// Design notes:
//  - The mic is requested LAZILY on the first `start()` gesture and the
//    MediaStream is kept alive across record cycles, so repeated recordings
//    never re-prompt for permission.
//  - Permission / device errors are normalized into a typed `RecorderError`
//    (recoverable UI state) rather than crashing the app.
//  - A max clip length AND a max byte size guard auto-stop long recordings so a
//    clip stays comfortably under the ~4.5 MB hosted-STT request cap.
//  - The shared AudioContext is resumed on the record gesture (autoplay policy)
//    so downstream lip-sync is unlocked.

import { resumeAudio as defaultResumeAudio } from "./context";

/** Opus-first MIME preference; the browser default ("") is the last resort. */
export const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
  "audio/wav",
] as const;

/** Auto-stop a clip after this long (safety net for a stuck push-to-talk). */
export const DEFAULT_MAX_DURATION_MS = 60_000;

/**
 * Auto-stop a clip once it reaches this many bytes. 4 MB leaves headroom under
 * Vercel's ~4.5 MB request cap once the audio is posted to hosted STT.
 */
export const DEFAULT_MAX_BYTES = 4_000_000;

/** Emit a data chunk every 250 ms so the size guard can react mid-recording. */
export const DEFAULT_TIMESLICE_MS = 250;

export type RecorderState =
  | "idle"
  | "requesting"
  | "recording"
  | "stopping"
  | "error";

export type RecorderErrorKind =
  | "permission-denied"
  | "no-device"
  | "not-supported"
  | "insecure-context"
  | "unknown";

/** Typed, recoverable recording error surfaced to the UI. */
export class RecorderError extends Error {
  readonly kind: RecorderErrorKind;
  readonly cause?: unknown;

  constructor(kind: RecorderErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "RecorderError";
    this.kind = kind;
    this.cause = cause;
    Object.setPrototypeOf(this, RecorderError.prototype);
  }
}

/** Injectable browser primitives (defaults read the real globals). */
export interface RecorderDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createRecorder?: (
    stream: MediaStream,
    options?: MediaRecorderOptions,
  ) => MediaRecorder;
  isTypeSupported?: (mime: string) => boolean;
  resumeAudio?: () => Promise<unknown>;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (token: ReturnType<typeof setTimeout>) => void;
}

export interface RecorderOptions {
  /** Max clip length before auto-stop (ms). */
  maxDurationMs?: number;
  /** Max clip size before auto-stop (bytes). */
  maxBytes?: number;
  /** MediaRecorder timeslice (ms) — governs how often the size guard checks. */
  timesliceMs?: number;
  /** Fired when a recording finalizes WITHOUT an awaited stop() (auto-stop). */
  onResult?: (blob: Blob) => void;
}

/**
 * Pick the best-supported recording MIME type, opus-first. Returns "" to let
 * the browser choose its own default when none of the candidates are supported.
 */
export function negotiateMimeType(isSupported?: (mime: string) => boolean): string {
  const supported =
    isSupported ??
    ((mime: string) => {
      const MR = (globalThis as { MediaRecorder?: typeof MediaRecorder })
        .MediaRecorder;
      return Boolean(MR?.isTypeSupported?.(mime));
    });
  for (const mime of PREFERRED_MIME_TYPES) {
    try {
      if (supported(mime)) return mime;
    } catch {
      // isTypeSupported can throw on some engines; treat as unsupported.
    }
  }
  return "";
}

function resolveGetUserMedia(
  deps: RecorderDeps,
): ((c: MediaStreamConstraints) => Promise<MediaStream>) | undefined {
  if (deps.getUserMedia) return deps.getUserMedia;
  const md = (globalThis as { navigator?: Navigator }).navigator?.mediaDevices;
  if (md?.getUserMedia) return md.getUserMedia.bind(md);
  return undefined;
}

function resolveCreateRecorder(
  deps: RecorderDeps,
): (stream: MediaStream, options?: MediaRecorderOptions) => MediaRecorder {
  if (deps.createRecorder) return deps.createRecorder;
  return (stream, options) => new MediaRecorder(stream, options);
}

/** Map a getUserMedia rejection to a typed, recoverable RecorderError. */
export function mapGetUserMediaError(err: unknown): RecorderError {
  const name =
    err && typeof err === "object" && "name" in err
      ? String((err as { name: unknown }).name)
      : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new RecorderError(
        "permission-denied",
        "Microphone permission was denied. You can still type your message.",
        err,
      );
    case "NotFoundError":
    case "DevicesNotFoundError":
      return new RecorderError(
        "no-device",
        "No microphone was found. Connect one, or type your message.",
        err,
      );
    case "NotReadableError":
    case "TrackStartError":
      return new RecorderError(
        "no-device",
        "The microphone is in use by another app.",
        err,
      );
    default:
      return new RecorderError(
        "unknown",
        "Could not start the microphone. You can still type your message.",
        err,
      );
  }
}

type StateListener = (state: RecorderState) => void;

export class MicRecorder {
  private readonly deps: RecorderDeps;
  private readonly maxDurationMs: number;
  private readonly maxBytes: number;
  private readonly timesliceMs: number;
  private readonly onResult?: (blob: Blob) => void;

  private state: RecorderState = "idle";
  private error: RecorderError | null = null;
  private mediaStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private bytes = 0;
  private mimeType = "";
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private stopResolvers: Array<(blob: Blob) => void> = [];
  private listeners = new Set<StateListener>();

  constructor(options: RecorderOptions = {}, deps: RecorderDeps = {}) {
    this.deps = deps;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.timesliceMs = options.timesliceMs ?? DEFAULT_TIMESLICE_MS;
    this.onResult = options.onResult;
  }

  getState(): RecorderState {
    return this.state;
  }

  getError(): RecorderError | null {
    return this.error;
  }

  /** The live MediaStream (for VAD / stream-based lip-sync). Null before start. */
  get stream(): MediaStream | null {
    return this.mediaStream;
  }

  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(next: RecorderState): void {
    if (this.state === next) return;
    this.state = next;
    for (const l of this.listeners) l(next);
  }

  private schedule(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    return (this.deps.setTimeout ?? setTimeout)(fn, ms);
  }

  private unschedule(token: ReturnType<typeof setTimeout> | null): void {
    if (token != null) (this.deps.clearTimeout ?? clearTimeout)(token);
  }

  /** Begin recording. Requests the mic on first use; safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.state === "recording" || this.state === "requesting") return;

    this.error = null;
    this.setState("requesting");

    // Acquire (or reuse) the mic stream.
    if (!this.mediaStream) {
      const getUserMedia = resolveGetUserMedia(this.deps);
      if (!getUserMedia) {
        const e = new RecorderError(
          "not-supported",
          "Microphone capture is not available in this browser or context.",
        );
        this.error = e;
        this.setState("error");
        throw e;
      }
      try {
        this.mediaStream = await getUserMedia({ audio: true });
      } catch (raw) {
        const e = mapGetUserMediaError(raw);
        this.error = e;
        this.setState("error");
        throw e;
      }
    }

    // Unlock the shared AudioContext for downstream lip-sync (autoplay policy).
    try {
      await (this.deps.resumeAudio ?? defaultResumeAudio)();
    } catch {
      // Non-fatal: a failed resume just means silent playback until the next
      // gesture; recording itself is unaffected.
    }

    this.chunks = [];
    this.bytes = 0;
    const mime = negotiateMimeType(this.deps.isTypeSupported);
    const create = resolveCreateRecorder(this.deps);
    const recorder = create(this.mediaStream, mime ? { mimeType: mime } : undefined);
    this.mimeType = mime || recorder.mimeType || "audio/webm";
    this.recorder = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      const data = event.data;
      if (data && data.size > 0) {
        this.chunks.push(data);
        this.bytes += data.size;
        if (this.bytes >= this.maxBytes && this.state === "recording") {
          this.autoStop();
        }
      }
    };
    recorder.onstop = () => this.finalize();

    recorder.start(this.timesliceMs);
    this.setState("recording");
    this.durationTimer = this.schedule(() => {
      if (this.state === "recording") this.autoStop();
    }, this.maxDurationMs);
  }

  /** Stop recording and resolve with the captured clip. */
  stop(): Promise<Blob> {
    if (this.state !== "recording") {
      // Nothing to stop — hand back whatever (possibly empty) buffer exists.
      return Promise.resolve(this.buildBlob());
    }
    this.setState("stopping");
    this.unschedule(this.durationTimer);
    this.durationTimer = null;
    const pending = new Promise<Blob>((resolve) => {
      this.stopResolvers.push(resolve);
    });
    this.recorder?.stop();
    return pending;
  }

  /** Internal auto-stop (size/duration guard) — no awaited stop() in flight. */
  private autoStop(): void {
    if (this.state !== "recording") return;
    this.setState("stopping");
    this.unschedule(this.durationTimer);
    this.durationTimer = null;
    this.recorder?.stop();
  }

  private buildBlob(): Blob {
    return new Blob(this.chunks, { type: this.mimeType || "audio/webm" });
  }

  private finalize(): void {
    const blob = this.buildBlob();
    this.recorder = null;
    this.setState("idle");

    // Resolve any awaited stop() calls first...
    if (this.stopResolvers.length > 0) {
      const resolvers = this.stopResolvers;
      this.stopResolvers = [];
      for (const resolve of resolvers) resolve(blob);
    } else if (blob.size > 0) {
      // ...otherwise this was an auto-stop: hand the clip to the result sink.
      this.onResult?.(blob);
    }
  }

  /** Release the mic stream entirely (next start() re-prompts). */
  dispose(): void {
    this.unschedule(this.durationTimer);
    this.durationTimer = null;
    try {
      this.recorder?.stop();
    } catch {
      // Already inactive — ignore.
    }
    this.recorder = null;
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore double-stop.
        }
      }
      this.mediaStream = null;
    }
    this.chunks = [];
    this.bytes = 0;
    this.stopResolvers = [];
    this.setState("idle");
  }
}

/** Convenience factory. */
export function createRecorder(
  options?: RecorderOptions,
  deps?: RecorderDeps,
): MicRecorder {
  return new MicRecorder(options, deps);
}
