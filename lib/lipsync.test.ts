import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VISEMES } from "wawa-lipsync";
import { createLipsync, estimateFeatures } from "./lipsync";
import { getAudioContext, resumeAudio, setAudioContext } from "./audio/context";

// --- Minimal Web Audio mock -------------------------------------------------
// jsdom has no Web Audio API, so we stub the pieces the engine touches. The
// analyser's spectrum is a per-frame function the test drives to simulate
// speech vs. silence.

type SpectrumFn = (bin: number) => number;

class MockAnalyserNode {
  fftSize = 2048;
  spectrum: SpectrumFn = () => 0;
  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }
  connect(): void {}
  disconnect(): void {}
  getByteFrequencyData(arr: Uint8Array): void {
    for (let i = 0; i < arr.length; i++) {
      const v = this.spectrum(i);
      arr[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
}

class MockSourceNode {
  connected = true;
  connect(): this {
    return this;
  }
  disconnect(): void {
    this.connected = false;
  }
}

class MockAudioContext {
  state: "running" | "suspended" | "closed" = "running";
  sampleRate = 48000;
  destination = {} as AudioDestinationNode;
  analysers: MockAnalyserNode[] = [];
  closed = false;
  createAnalyser(): MockAnalyserNode {
    const a = new MockAnalyserNode();
    this.analysers.push(a);
    return a;
  }
  createMediaElementSource(): MockSourceNode {
    return new MockSourceNode();
  }
  createMediaStreamSource(): MockSourceNode {
    return new MockSourceNode();
  }
  async resume(): Promise<void> {
    this.state = "running";
  }
  async close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
  }
}

function installMockAudio(): void {
  (window as unknown as { AudioContext: unknown }).AudioContext = MockAudioContext;
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = MockAudioContext;
}

// Speech-like spectrum: energy concentrated below ~5 kHz, scaled by `level`.
function speechSpectrum(level: number): SpectrumFn {
  // binWidth = 48000 / 2048 ≈ 23.4 Hz; bin 200 ≈ 4.7 kHz.
  return (bin) => (bin < 210 ? level : 0);
}

function analyserOf(ctx: MockAudioContext): MockAnalyserNode {
  // The engine creates exactly one analyser (its shared one).
  return ctx.analysers[ctx.analysers.length - 1];
}

let ctx: MockAudioContext;

beforeEach(() => {
  installMockAudio();
  ctx = new MockAudioContext();
  setAudioContext(ctx as unknown as AudioContext);
});

afterEach(() => {
  setAudioContext(null);
});

describe("shared audio context", () => {
  it("returns a lazily-created singleton", () => {
    setAudioContext(null);
    const a = getAudioContext();
    const b = getAudioContext();
    expect(a).toBe(b);
  });

  it("resumeAudio resumes a suspended context", async () => {
    ctx.state = "suspended";
    const resumed = await resumeAudio();
    expect(resumed.state).toBe("running");
  });
});

describe("LipsyncEngine amplitude/viseme", () => {
  it("volume oscillates 0..1 in sync with speech and yields valid viseme labels", () => {
    const engine = createLipsync({ audioContext: ctx as unknown as AudioContext });
    const el = { src: "clip.wav" } as unknown as HTMLMediaElement;
    engine.connectMediaElement(el);
    const analyser = analyserOf(ctx);

    // A rise-then-fall amplitude "envelope" of a spoken syllable.
    const levels = [0, 40, 90, 150, 210, 255, 210, 150, 90, 40, 0];
    const volumes: number[] = [];
    const visemes = new Set<string>();
    const validVisemes = new Set(Object.values(VISEMES) as string[]);

    for (const level of levels) {
      analyser.spectrum = speechSpectrum(level);
      engine.processFrame();
      const f = engine.getFeatures();
      volumes.push(f.volume);
      expect(f.volume).toBeGreaterThanOrEqual(0);
      expect(f.volume).toBeLessThanOrEqual(1);
      expect(f.viseme.length).toBeGreaterThan(0);
      expect(validVisemes.has(f.viseme)).toBe(true);
      // Scores object is populated and finite.
      expect(Object.keys(f.visemeScores).length).toBeGreaterThan(0);
      for (const s of Object.values(f.visemeScores)) expect(Number.isFinite(s)).toBe(true);
      visemes.add(f.viseme);
    }

    const peak = Math.max(...volumes);
    const start = volumes[0];
    expect(peak).toBeGreaterThan(0.3); // real amplitude during "speech"
    expect(peak).toBeGreaterThan(start); // rose from the silent start
    // At least one frame produced an actual (non-silence) mouth shape.
    const nonSil = [...visemes].filter((v) => v !== (VISEMES.sil as string));
    expect(nonSil.length).toBeGreaterThan(0);
  });

  it("volume decays to ~0 when no audio is playing", () => {
    const engine = createLipsync({ audioContext: ctx as unknown as AudioContext, decay: 0.4 });
    engine.connectMediaElement({ src: "clip.wav" } as unknown as HTMLMediaElement);
    const analyser = analyserOf(ctx);

    // Prime with loud speech so smoothedVolume is high.
    analyser.spectrum = speechSpectrum(255);
    for (let i = 0; i < 5; i++) engine.processFrame();
    expect(engine.getFeatures().volume).toBeGreaterThan(0.3);

    // Go silent; volume must decay toward zero.
    analyser.spectrum = () => 0;
    for (let i = 0; i < 40; i++) engine.processFrame();
    expect(engine.getFeatures().volume).toBeLessThan(0.05);
  });

  it("disconnect releases the source node and zeroes volume", () => {
    const engine = createLipsync({ audioContext: ctx as unknown as AudioContext });
    engine.connectMediaElement({ src: "clip.wav" } as unknown as HTMLMediaElement);
    analyserOf(ctx).spectrum = speechSpectrum(255);
    engine.processFrame();
    expect(engine.getFeatures().volume).toBeGreaterThan(0);
    engine.disconnect();
    expect(engine.getFeatures().volume).toBe(0);
  });

  it("reset fully releases the source and clears accumulated state", () => {
    const engine = createLipsync({ audioContext: ctx as unknown as AudioContext });
    engine.connectMediaElement({ src: "clip.wav" } as unknown as HTMLMediaElement);
    analyserOf(ctx).spectrum = speechSpectrum(255);
    engine.processFrame();
    expect(engine.getFeatures().volume).toBeGreaterThan(0);
    engine.reset();
    expect(engine.getFeatures().volume).toBe(0);
  });

  it("getEstimatedFeatures delegates to the Web Speech estimateFeatures fallback", () => {
    const engine = createLipsync({ audioContext: ctx as unknown as AudioContext });
    const direct = estimateFeatures("hello there", 350);
    expect(engine.getEstimatedFeatures("hello there", 350)).toEqual(direct);
  });

  it("connectStream taps a stream without wiring it to the speakers", () => {
    const engine = createLipsync({ audioContext: ctx as unknown as AudioContext });
    // Should not throw; drives the mic/VAD path.
    engine.connectStream({} as unknown as MediaStream);
    analyserOf(ctx).spectrum = speechSpectrum(200);
    engine.processFrame();
    expect(engine.getFeatures().volume).toBeGreaterThan(0);
  });
});

describe("estimateFeatures (Web Speech fallback)", () => {
  it("produces a plausible envelope with non-empty viseme labels mid-utterance", () => {
    const text = "hello there, this is a spoken sentence for the face";
    const samples: number[] = [];
    let sawNonSil = false;
    const validVisemes = new Set(Object.values(VISEMES) as string[]);
    for (let t = 0; t < 3000; t += 60) {
      const f = estimateFeatures(text, t);
      expect(f.volume).toBeGreaterThanOrEqual(0);
      expect(f.volume).toBeLessThanOrEqual(1);
      expect(f.viseme.length).toBeGreaterThan(0);
      expect(validVisemes.has(f.viseme)).toBe(true);
      if (f.viseme !== (VISEMES.sil as string)) sawNonSil = true;
      samples.push(f.volume);
    }
    expect(Math.max(...samples)).toBeGreaterThan(0.3);
    expect(sawNonSil).toBe(true);
  });

  it("returns silence before start and after the utterance ends", () => {
    const text = "short one";
    expect(estimateFeatures(text, -10).volume).toBe(0);
    expect(estimateFeatures(text, 999_999).volume).toBe(0);
    expect(estimateFeatures("", 100).volume).toBe(0);
    expect(estimateFeatures(text, 999_999).viseme).toBe(VISEMES.sil as string);
  });
});
