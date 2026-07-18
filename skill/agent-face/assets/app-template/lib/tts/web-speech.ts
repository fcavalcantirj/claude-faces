// Web Speech API TTS — the zero-infra voice-out engine.
//
// Wraps the browser `SpeechSynthesis` API into the same shape the TTS router
// (a later task) drives: `speak(text)`, `cancel()`, lifecycle callbacks
// (onStart / onEnd / onBoundary), and voice selection.
//
// Two Web-Speech realities this module works around:
//   1. The ~15s Chrome truncation bug — long single utterances get cut off. We
//      CHUNK the reply into <=~200-char, sentence-sized utterances and speak
//      them ONE AT A TIME (the next only after the previous ends), so no single
//      utterance ever runs long enough to trip the cutoff and the queue stays
//      short enough to cancel instantly for barge-in.
//   2. No tappable audio node — SpeechSynthesis plays through the OS, exposing
//      no AudioNode for the FFT analyser. So the mouth is driven by a SYNTHETIC
//      envelope (lib/lipsync `estimateFeatures`) advanced by the active
//      utterance's elapsed time and refreshed on `onboundary` word events,
//      rather than the real-audio analyser path used by OpenAI/Kokoro TTS.
//
// Everything heavy/browser is injectable (`WebSpeechDeps`), so the whole
// controller is headlessly testable under jsdom with a fake synth — no real
// speech, no rAF.

import { estimateFeatures, type LipsyncFeatures } from "@/lib/lipsync";
import { splitSentences } from "@/lib/chat/client";
import { type MouthState } from "@/components/agent-face";

/** Max characters per utterance — well under the ~15s Chrome truncation window. */
export const MAX_UTTERANCE_CHARS = 200;

/** The subset of `SpeechSynthesisVoice` we surface to settings. */
export interface SpeechSynthesisVoiceLike {
  name: string;
  lang: string;
  voiceURI: string;
  default: boolean;
  localService: boolean;
}

/** The subset of `SpeechSynthesisUtterance` this module sets/observes. */
export interface SpeechSynthesisUtteranceLike {
  text: string;
  voice: SpeechSynthesisVoiceLike | null;
  lang: string;
  rate: number;
  pitch: number;
  volume: number;
  onstart: ((ev: unknown) => void) | null;
  onend: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onboundary: ((ev: { charIndex: number; name?: string }) => void) | null;
}

/** The subset of `SpeechSynthesis` this module drives. */
export interface SpeechSynthesisLike {
  speak(utterance: SpeechSynthesisUtteranceLike): void;
  cancel(): void;
  getVoices(): SpeechSynthesisVoiceLike[];
  speaking: boolean;
  paused: boolean;
  pending: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** A forwarded word/sentence boundary from the active utterance. */
export interface BoundaryInfo {
  /** Character offset into the utterance text. */
  charIndex: number;
  /** Boundary kind, e.g. 'word' | 'sentence'. */
  name?: string;
  /** Index of the utterance (chunk) within the current reply. */
  utterance: number;
}

/** Lifecycle callbacks the orchestrator wires to the emotion machine + mouth. */
export interface WebSpeechCallbacks {
  /** First utterance of a reply started — orchestrator sets emotion 'speaking'. */
  onStart?: () => void;
  /** The whole reply finished speaking — orchestrator returns to the resting emotion. */
  onEnd?: () => void;
  /** A word/sentence boundary in the active utterance (drives progress/mouth). */
  onBoundary?: (info: BoundaryInfo) => void;
  /** An utterance error surfaced out-of-band (the queue still continues). */
  onError?: (err: unknown) => void;
  /** Per-frame estimated mouth features (also written to `mouthRef`). */
  onMouth?: (features: LipsyncFeatures) => void;
  /** The available voice list changed (populate the settings picker). */
  onVoicesChanged?: (voices: SpeechSynthesisVoiceLike[]) => void;
}

/** Voice/prosody options + the shared mouth ref for the estimated envelope. */
export interface WebSpeechOptions {
  /** Preferred voice, matched by `voiceURI` then `name`. */
  voiceURI?: string;
  /** BCP-47 language tag applied to each utterance. */
  lang?: string;
  /** Speaking rate (0.1..10, default 1). */
  rate?: number;
  /** Pitch (0..2, default 1). */
  pitch?: number;
  /** Volume (0..1, default 1). */
  volume?: number;
  /** Override the per-utterance character cap. */
  maxChars?: number;
  /** Ref the estimated mouth envelope writes into each frame (mouthSource 'estimated'). */
  mouthRef?: { current: MouthState | null };
}

/** Injectable heavy/browser primitives (defaults use the real Web Speech API). */
export interface WebSpeechDeps {
  synth?: SpeechSynthesisLike;
  createUtterance?: (text: string) => SpeechSynthesisUtteranceLike;
  now?: () => number;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
}

const SILENCE: LipsyncFeatures = estimateFeatures("", 0);

/** True when the browser exposes a usable SpeechSynthesis. */
export function isWebSpeechAvailable(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { speechSynthesis?: unknown }).speechSynthesis !== "undefined" &&
    typeof (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance !==
      "undefined"
  );
}

// --- chunking --------------------------------------------------------------

/**
 * Split a full reply into speakable chunks: ONE per sentence (finer barge-in
 * granularity, and each stays well under the ~15s window), each <= `maxLen`
 * chars. A single over-long sentence is split on word boundaries (and a monster
 * word is hard-split). Whitespace is collapsed; empty/blank input yields no chunks.
 */
export function chunkForSpeech(text: string, maxLen = MAX_UTTERANCE_CHARS): string[] {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return [];

  const chunks: string[] = [];
  for (const sentence of splitIntoSentences(clean)) {
    if (sentence.length > maxLen) {
      for (const piece of splitLong(sentence, maxLen)) chunks.push(piece);
    } else {
      chunks.push(sentence);
    }
  }
  return chunks;
}

/** Break a complete string into sentences, reusing the chat client's splitter. */
function splitIntoSentences(text: string): string[] {
  // Appending a newline forces the final terminator to be treated as a boundary
  // (splitSentences otherwise leaves a trailing sentence in `rest`).
  const { sentences, rest } = splitSentences(`${text}\n`);
  const tail = rest.trim();
  return tail ? [...sentences, tail] : sentences;
}

/** Split an over-long sentence on word boundaries into <= maxLen pieces. */
function splitLong(sentence: string, maxLen: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of sentence.split(/\s+/)) {
    if (word.length > maxLen) {
      if (current) {
        out.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += maxLen) out.push(word.slice(i, i + maxLen));
      continue;
    }
    if (current && current.length + 1 + word.length > maxLen) {
      out.push(current);
      current = "";
    }
    current = current ? `${current} ${word}` : word;
  }
  if (current) out.push(current);
  return out;
}

// --- controller ------------------------------------------------------------

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Web Speech TTS controller. Construct once (via {@link createWebSpeechTTS})
 * with callbacks + voice options, then `speak(text)` to queue a reply and
 * `cancel()` to stop it instantly for barge-in.
 */
export class WebSpeechTTS {
  private readonly callbacks: WebSpeechCallbacks;
  private readonly options: WebSpeechOptions;
  private readonly deps: WebSpeechDeps;

  private queue: string[] = [];
  /** Bumped on every speak()/cancel() so stale utterance handlers no-op. */
  private gen = 0;
  private speaking = false;
  private started = false;
  private voices: SpeechSynthesisVoiceLike[] = [];
  private selectedVoiceURI: string | undefined;

  private activeText = "";
  private utteranceStartedAt = 0;
  private activeIndex = 0;
  private frameId: number | null = null;
  private readonly onVoices = () => this.refreshVoices();

  constructor(
    callbacks: WebSpeechCallbacks = {},
    options: WebSpeechOptions = {},
    deps: WebSpeechDeps = {},
  ) {
    this.callbacks = callbacks;
    this.options = options;
    this.deps = deps;
    this.selectedVoiceURI = options.voiceURI;

    const synth = this.deps.synth ?? this.globalSynth();
    if (synth) {
      this.voices = synth.getVoices() ?? [];
      synth.addEventListener("voiceschanged", this.onVoices);
    }
  }

  private globalSynth(): SpeechSynthesisLike | undefined {
    return (globalThis as { speechSynthesis?: SpeechSynthesisLike }).speechSynthesis;
  }

  private getSynth(): SpeechSynthesisLike {
    const synth = this.deps.synth ?? this.globalSynth();
    if (!synth) {
      throw new Error("Web Speech API is unavailable in this environment.");
    }
    return synth;
  }

  private now(): number {
    return (this.deps.now ?? defaultNow)();
  }

  /** Current available voices (populated from `getVoices` + `voiceschanged`). */
  getVoices(): SpeechSynthesisVoiceLike[] {
    return this.voices;
  }

  /** Choose a voice by `voiceURI` (preferred) or `name`; applied to new utterances. */
  setVoice(voiceURIorName: string | undefined): void {
    this.selectedVoiceURI = voiceURIorName;
  }

  /** True while a reply is being spoken (between first onStart and final onEnd). */
  isSpeaking(): boolean {
    return this.speaking;
  }

  private refreshVoices(): void {
    const synth = this.deps.synth ?? this.globalSynth();
    if (!synth) return;
    this.voices = synth.getVoices() ?? [];
    this.callbacks.onVoicesChanged?.(this.voices);
  }

  private resolveVoice(): SpeechSynthesisVoiceLike | null {
    if (!this.selectedVoiceURI) return null;
    return (
      this.voices.find((v) => v.voiceURI === this.selectedVoiceURI) ??
      this.voices.find((v) => v.name === this.selectedVoiceURI) ??
      null
    );
  }

  /**
   * Queue a full reply and start speaking it chunk-by-chunk. Any in-flight
   * speech is cancelled first, so a new reply cleanly replaces the old.
   */
  speak(text: string): void {
    const chunks = chunkForSpeech(text, this.options.maxChars ?? MAX_UTTERANCE_CHARS);
    this.cancel();
    if (chunks.length === 0) return;

    this.gen += 1;
    this.queue = chunks;
    this.speaking = true;
    this.started = false;
    this.activeIndex = 0;
    this.speakNext(this.gen);
  }

  private speakNext(gen: number): void {
    if (gen !== this.gen) return;
    const text = this.queue.shift();
    if (text === undefined) {
      this.finish();
      return;
    }

    const index = this.activeIndex++;
    const synth = this.getSynth();
    const make =
      this.deps.createUtterance ??
      ((t: string) =>
        new (globalThis as { SpeechSynthesisUtterance: new (t: string) => SpeechSynthesisUtteranceLike }).SpeechSynthesisUtterance(
          t,
        ));
    const u = make(text);
    u.voice = this.resolveVoice();
    if (this.options.lang) u.lang = this.options.lang;
    u.rate = this.options.rate ?? 1;
    u.pitch = this.options.pitch ?? 1;
    u.volume = this.options.volume ?? 1;

    u.onstart = () => {
      if (gen !== this.gen) return;
      this.activeText = text;
      this.utteranceStartedAt = this.now();
      if (!this.started) {
        this.started = true;
        this.callbacks.onStart?.();
      }
      this.startFrameLoop();
    };
    u.onboundary = (ev) => {
      if (gen !== this.gen) return;
      this.callbacks.onBoundary?.({
        charIndex: ev?.charIndex ?? 0,
        name: ev?.name,
        utterance: index,
      });
    };
    u.onend = () => {
      if (gen !== this.gen) return;
      this.speakNext(gen);
    };
    u.onerror = (ev) => {
      if (gen !== this.gen) return;
      this.callbacks.onError?.(ev);
      // An error on one chunk shouldn't kill the reply — advance the queue.
      this.speakNext(gen);
    };

    synth.speak(u);
  }

  private finish(): void {
    this.speaking = false;
    this.activeText = "";
    this.stopFrameLoop();
    this.writeMouth(SILENCE);
    this.callbacks.onEnd?.();
  }

  /**
   * Barge-in: stop all queued speech immediately, silence the mouth, and mark
   * the controller idle. Does NOT fire onEnd (a cancel is not a natural finish).
   */
  cancel(): void {
    const wasActive = this.speaking || this.queue.length > 0 || this.frameId !== null;
    this.gen += 1; // invalidate any in-flight utterance handlers
    this.queue = [];
    this.started = false;
    this.speaking = false;
    this.activeText = "";
    this.stopFrameLoop();
    // Only touch the synth if we actually had speech going — a pre-speak reset
    // on an idle controller must not count as a cancel.
    if (wasActive) {
      const synth = this.deps.synth ?? this.globalSynth();
      try {
        synth?.cancel();
      } catch {
        // Already stopped — ignore.
      }
    }
    this.writeMouth(SILENCE);
  }

  /** Detach the voiceschanged listener; call when tearing the engine down. */
  dispose(): void {
    this.cancel();
    const synth = this.deps.synth ?? this.globalSynth();
    synth?.removeEventListener("voiceschanged", this.onVoices);
  }

  /** Estimated mouth features for the active utterance at the current time. */
  currentMouth(): LipsyncFeatures {
    if (!this.speaking || !this.activeText) return SILENCE;
    return estimateFeatures(this.activeText, this.now() - this.utteranceStartedAt);
  }

  private writeMouth(features: LipsyncFeatures): void {
    if (this.options.mouthRef) {
      this.options.mouthRef.current = { open: features.volume, viseme: features.viseme };
    }
    this.callbacks.onMouth?.(features);
  }

  private startFrameLoop(): void {
    if (this.frameId !== null) return;
    const raf = this.deps.raf ?? defaultRaf;
    const tick = () => {
      if (!this.speaking) {
        this.frameId = null;
        return;
      }
      this.writeMouth(this.currentMouth());
      this.frameId = raf(tick);
    };
    this.frameId = raf(tick);
  }

  private stopFrameLoop(): void {
    if (this.frameId !== null) {
      (this.deps.caf ?? defaultCaf)(this.frameId);
      this.frameId = null;
    }
  }
}

function defaultRaf(cb: (t: number) => void): number {
  if (typeof requestAnimationFrame !== "undefined") return requestAnimationFrame(cb);
  return setTimeout(() => cb(defaultNow()), 16) as unknown as number;
}

function defaultCaf(id: number): void {
  if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(id);
  else clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}

/** Convenience factory mirroring the other engine factories. */
export function createWebSpeechTTS(
  callbacks?: WebSpeechCallbacks,
  options?: WebSpeechOptions,
  deps?: WebSpeechDeps,
): WebSpeechTTS {
  return new WebSpeechTTS(callbacks, options, deps);
}
