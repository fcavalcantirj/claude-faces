// Amplitude + viseme engine.
//
// Thin wrapper around `wawa-lipsync` that (a) forces it onto the app's single
// shared AudioContext (see ./audio/context), (b) adds attack/decay smoothing so
// the mouth doesn't strobe on every FFT frame, and (c) provides a text-driven
// fallback for the Web Speech path, which exposes no tappable audio node.

import { Lipsync, VISEMES } from "wawa-lipsync";
import { getAudioContext } from "./audio/context";

export interface LipsyncFeatures {
  /** Smoothed, clamped 0..1 amplitude — drives mouth openness. */
  volume: number;
  /** Dominant viseme label, e.g. "viseme_aa". Never empty. */
  viseme: string;
  /** Per-viseme scores (label -> weight); useful for blend-shape lip-sync. */
  visemeScores: Record<string, number>;
}

export interface CreateLipsyncOptions {
  /** AnalyserNode FFT size (power of two). Default 2048. */
  fftSize?: number;
  /** How many frames wawa-lipsync averages for state detection. Default 10. */
  historySize?: number;
  /** Rise smoothing 0..1 (higher = snappier onset). Default 0.5. */
  attack?: number;
  /** Fall smoothing 0..1 (lower = longer tail). Default 0.15. */
  decay?: number;
  /** Inject an AudioContext; defaults to the shared singleton. */
  audioContext?: AudioContext;
}

const SIL = VISEMES.sil as string;

const ZERO_SCORES: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Object.values(VISEMES).map((v) => [v as string, 0])),
);

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// wawa-lipsync keeps the pieces we must re-point at the shared context (its
// constructor otherwise spins up a private throwaway AudioContext) as private
// fields. This is the minimal shape we reach into via a cast.
interface WawaFeature {
  volume: number;
  centroid: number;
  bands: number[];
  deltaBands: number[];
}
interface LipsyncInternal {
  audioContext: AudioContext;
  analyser: AnalyserNode;
  dataArray: Uint8Array;
  history: WawaFeature[];
  features: WawaFeature | null;
  viseme: string;
  state: string;
  visemeStartTime: number;
  sampleRate: number;
  binWidth: number;
}

export class LipsyncEngine {
  private readonly lip: Lipsync;
  private readonly internal: LipsyncInternal;
  private readonly ctx: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly attack: number;
  private readonly decay: number;

  private source: AudioNode | null = null;
  private wiredToDestination = false;
  private smoothedVolume = 0;

  constructor(opts: CreateLipsyncOptions = {}) {
    const { fftSize = 2048, historySize = 10, attack = 0.5, decay = 0.15 } = opts;
    this.attack = clamp01(attack);
    this.decay = clamp01(decay);
    this.ctx = opts.audioContext ?? getAudioContext();

    this.lip = new Lipsync({ fftSize, historySize });
    this.internal = this.lip as unknown as LipsyncInternal;

    // Re-point wawa-lipsync at our single shared context. Its constructor
    // already built an AnalyserNode on a private context; close that and swap
    // in an analyser wired into the graph everything else plays through.
    const throwaway = this.internal.audioContext;
    if (throwaway && throwaway !== this.ctx) {
      void throwaway.close?.();
    }
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = fftSize;

    this.internal.audioContext = this.ctx;
    this.internal.analyser = this.analyser;
    this.internal.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.internal.sampleRate = this.ctx.sampleRate;
    this.internal.binWidth = this.ctx.sampleRate / fftSize;
  }

  /**
   * Tap an <audio>/<video> element (e.g. a TTS clip). Routes it
   * source -> analyser -> destination so the tapped signal is exactly what
   * plays. NOTE: a given element can only be tapped once per AudioContext, so
   * create a fresh element per utterance.
   */
  connectMediaElement(el: HTMLMediaElement): void {
    this.disconnect();
    const src = this.ctx.createMediaElementSource(el);
    src.connect(this.analyser);
    this.ensureDestination();
    this.source = src;
    this.resetState();
  }

  /**
   * Tap a live MediaStream (mic/VAD). Wired source -> analyser only — stream
   * input is deliberately NOT routed to the speakers to avoid echo/feedback.
   */
  connectStream(stream: MediaStream): void {
    this.disconnect();
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(this.analyser);
    this.source = src;
    this.resetState();
  }

  /** Call once per animation frame (rAF) to pull fresh features. */
  processFrame(): void {
    this.lip.processAudio();
    const raw = clamp01(this.internal.features?.volume ?? 0);
    const k = raw > this.smoothedVolume ? this.attack : this.decay;
    this.smoothedVolume = clamp01(this.smoothedVolume + (raw - this.smoothedVolume) * k);
  }

  /** Current smoothed amplitude, dominant viseme, and full viseme scores. */
  getFeatures(): LipsyncFeatures {
    return {
      volume: this.smoothedVolume,
      viseme: this.internal.viseme || SIL,
      visemeScores: this.computeScores(),
    };
  }

  /**
   * Fallback for the Web Speech path, which plays through the OS and exposes no
   * AudioNode to analyse. Synthesizes a plausible amplitude envelope + viseme
   * from the utterance text and elapsed time. Delegates to `estimateFeatures`.
   */
  getEstimatedFeatures(text: string, elapsedMs: number): LipsyncFeatures {
    return estimateFeatures(text, elapsedMs);
  }

  /** Release the current source node (call between utterances). */
  disconnect(): void {
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        // Already disconnected — ignore.
      }
      this.source = null;
    }
    this.smoothedVolume = 0;
  }

  /** Fully reset: release the source and clear all accumulated state. */
  reset(): void {
    this.disconnect();
    this.resetState();
  }

  private ensureDestination(): void {
    if (!this.wiredToDestination) {
      this.analyser.connect(this.ctx.destination);
      this.wiredToDestination = true;
    }
  }

  private resetState(): void {
    this.internal.history = [];
    this.internal.features = null;
    this.internal.state = "silence";
    this.internal.viseme = SIL;
    this.smoothedVolume = 0;
    if (typeof performance !== "undefined") {
      this.internal.visemeStartTime = performance.now();
    }
  }

  private computeScores(): Record<string, number> {
    const history = this.internal.history;
    if (!history || history.length === 0) {
      return { ...ZERO_SCORES, [SIL]: 1 };
    }
    const current = history[history.length - 1];
    const avg = this.lip.getAveragedFeatures() as unknown as WawaFeature;
    const dVolume = current.volume - avg.volume;
    const dCentroid = current.centroid - avg.centroid;
    // Reuse wawa-lipsync's own scoring so scores stay consistent with `.viseme`.
    const raw = this.lip.computeVisemeScores(
      current as never,
      avg as never,
      dVolume,
      dCentroid,
    );
    return this.lip.adjustScoresForConsistency(raw as never) as Record<string, number>;
  }
}

/** Convenience factory. */
export function createLipsync(opts: CreateLipsyncOptions = {}): LipsyncEngine {
  return new LipsyncEngine(opts);
}

// --- Web Speech estimation --------------------------------------------------

const VOWEL_VISEMES = [
  VISEMES.aa,
  VISEMES.E,
  VISEMES.I,
  VISEMES.O,
  VISEMES.U,
] as string[];
const CONSONANT_VISEMES = [
  VISEMES.PP,
  VISEMES.FF,
  VISEMES.DD,
  VISEMES.kk,
  VISEMES.SS,
  VISEMES.nn,
  VISEMES.RR,
  VISEMES.CH,
  VISEMES.TH,
] as string[];
const VOWEL_MAP: Record<string, string> = {
  a: VISEMES.aa,
  e: VISEMES.E,
  i: VISEMES.I,
  o: VISEMES.O,
  u: VISEMES.U,
};

/**
 * Synthesize a plausible {volume, viseme, visemeScores} for a spoken string at
 * `elapsedMs`, with no audio to analyse. Deterministic in (text, elapsedMs).
 * Uses an estimated duration (~180 wpm) with fade-in/out and syllable-rate +
 * word-rate amplitude modulation, and picks a viseme from the character the
 * playhead is currently over.
 */
export function estimateFeatures(text: string, elapsedMs: number): LipsyncFeatures {
  const clean = (text ?? "").trim();
  const words = clean ? clean.split(/\s+/).length : 0;
  const totalMs = words > 0 ? words * 330 + 250 : 0;

  if (elapsedMs < 0 || totalMs === 0 || elapsedMs >= totalMs) {
    return { volume: 0, viseme: SIL, visemeScores: { ...ZERO_SCORES, [SIL]: 1 } };
  }

  const remaining = totalMs - elapsedMs;
  const fadeIn = 90;
  const fadeOut = 140;
  let env = 1;
  if (elapsedMs < fadeIn) env = elapsedMs / fadeIn;
  if (remaining < fadeOut) env = Math.min(env, remaining / fadeOut);

  const seconds = elapsedMs / 1000;
  const syllable = 0.5 + 0.5 * Math.sin(seconds * 2 * Math.PI * 4.5);
  const wordGap = 0.5 + 0.5 * Math.sin(seconds * 2 * Math.PI * 1.6);
  const volume = clamp01(env * (0.25 + 0.5 * syllable) * (0.6 + 0.4 * wordGap));

  const idx = Math.min(clean.length - 1, Math.floor((elapsedMs / totalMs) * clean.length));
  const ch = (clean[idx] ?? "").toLowerCase();
  const viseme = visemeForChar(ch, elapsedMs);

  const visemeScores: Record<string, number> = {
    ...ZERO_SCORES,
    [viseme]: clamp01(volume + 0.2),
    [SIL]: clamp01(1 - volume),
  };
  return { volume, viseme, visemeScores };
}

function visemeForChar(ch: string, elapsedMs: number): string {
  if (ch in VOWEL_MAP) return VOWEL_MAP[ch];
  if (/[a-z]/.test(ch)) {
    return CONSONANT_VISEMES[Math.floor(elapsedMs / 90) % CONSONANT_VISEMES.length];
  }
  // Whitespace/punctuation: keep the mouth plausibly moving rather than snapping shut.
  return VOWEL_VISEMES[Math.floor(elapsedMs / 120) % VOWEL_VISEMES.length];
}
