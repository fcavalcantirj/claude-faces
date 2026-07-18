import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chunkForSpeech,
  createWebSpeechTTS,
  isWebSpeechAvailable,
  type SpeechSynthesisLike,
  type SpeechSynthesisUtteranceLike,
  type SpeechSynthesisVoiceLike,
} from "@/lib/tts/web-speech";

// --- Fakes -----------------------------------------------------------------
// jsdom has no SpeechSynthesis, so we inject the browser primitives and drive
// utterance lifecycle events by hand for deterministic, headless tests.

class FakeUtterance implements SpeechSynthesisUtteranceLike {
  voice: SpeechSynthesisVoiceLike | null = null;
  lang = "";
  rate = 1;
  pitch = 1;
  volume = 1;
  onstart: ((ev: unknown) => void) | null = null;
  onend: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onboundary: ((ev: { charIndex: number; name?: string }) => void) | null = null;
  constructor(public text: string) {}
}

class FakeSynth implements SpeechSynthesisLike {
  speaking = false;
  paused = false;
  pending = false;
  spoken: FakeUtterance[] = [];
  cancelCount = 0;
  voices: SpeechSynthesisVoiceLike[] = [];
  private listeners: Record<string, Array<() => void>> = {};

  speak(u: SpeechSynthesisUtteranceLike): void {
    this.speaking = true;
    this.spoken.push(u as FakeUtterance);
  }
  cancel(): void {
    this.cancelCount += 1;
    this.speaking = false;
  }
  getVoices(): SpeechSynthesisVoiceLike[] {
    return this.voices;
  }
  addEventListener(type: string, cb: () => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== cb);
  }
  fireVoicesChanged(): void {
    for (const cb of this.listeners["voiceschanged"] ?? []) cb();
  }

  /** Test helper: fire onstart on the most recently queued utterance. */
  startLatest(): void {
    this.spoken[this.spoken.length - 1]?.onstart?.({});
  }
  /** Test helper: fire onend on the most recently queued utterance. */
  endLatest(): void {
    this.spoken[this.spoken.length - 1]?.onend?.({});
  }
}

function voice(
  name: string,
  lang: string,
  voiceURI = name,
): SpeechSynthesisVoiceLike {
  return { name, lang, voiceURI, default: false, localService: true };
}

function makeDeps(synth: FakeSynth) {
  return {
    synth,
    createUtterance: (t: string) => new FakeUtterance(t),
    // No-op frame loop so the internal mouth rAF never schedules in tests.
    raf: () => 0,
    caf: () => {},
    now: () => 0,
  };
}

// --- chunkForSpeech --------------------------------------------------------

describe("chunkForSpeech", () => {
  it("splits a multi-sentence reply into sentence-sized chunks", () => {
    const chunks = chunkForSpeech("Hello there. How are you today? I am fine.");
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Every chunk stays comfortably under the ~15s Chrome truncation window.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    // No content is lost and nothing is empty.
    for (const c of chunks) expect(c.trim().length).toBeGreaterThan(0);
    expect(chunks.join(" ")).toContain("Hello there.");
    expect(chunks.join(" ")).toContain("I am fine.");
  });

  it("hard-splits a very long punctuation-free sentence on word boundaries", () => {
    const long = Array.from({ length: 80 }, () => "word").join(" "); // ~399 chars
    const chunks = chunkForSpeech(long, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50);
    expect(chunks.join(" ").split(/\s+/).length).toBe(80);
  });

  it("returns no chunks for empty/whitespace text", () => {
    expect(chunkForSpeech("")).toEqual([]);
    expect(chunkForSpeech("   \n  ")).toEqual([]);
  });
});

// --- queueing + lifecycle --------------------------------------------------

describe("WebSpeechTTS queue + lifecycle", () => {
  it("speaks chunks sequentially, one at a time", () => {
    const synth = new FakeSynth();
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const tts = createWebSpeechTTS({ onStart, onEnd }, {}, makeDeps(synth));

    tts.speak("Hello there. How are you today? I am fine.");

    // Only the first utterance is handed to the synth up front.
    expect(synth.spoken.length).toBe(1);
    synth.startLatest();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(tts.isSpeaking()).toBe(true);

    // The next chunk is only spoken after the previous one ends.
    synth.endLatest();
    expect(synth.spoken.length).toBe(2);
    synth.startLatest();
    synth.endLatest();
    expect(synth.spoken.length).toBe(3);
    synth.startLatest();

    // onStart fires exactly once for the whole reply, onEnd not yet.
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();

    // Final utterance ends → whole reply done.
    synth.endLatest();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(tts.isSpeaking()).toBe(false);
  });

  it("cancel() immediately silences the queue and does not fire onEnd", () => {
    const synth = new FakeSynth();
    const onEnd = vi.fn();
    const tts = createWebSpeechTTS({ onEnd }, {}, makeDeps(synth));

    tts.speak("One. Two. Three. Four. Five.");
    synth.startLatest();
    expect(synth.spoken.length).toBe(1);

    tts.cancel();
    expect(synth.cancelCount).toBe(1);
    expect(tts.isSpeaking()).toBe(false);

    // A late onend from the cancelled utterance must NOT advance the queue.
    synth.endLatest();
    expect(synth.spoken.length).toBe(1);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("forwards word boundary events", () => {
    const synth = new FakeSynth();
    const onBoundary = vi.fn();
    const tts = createWebSpeechTTS({ onBoundary }, {}, makeDeps(synth));
    tts.speak("Hello world.");
    synth.startLatest();
    synth.spoken[0].onboundary?.({ charIndex: 6, name: "word" });
    expect(onBoundary).toHaveBeenCalledTimes(1);
    expect(onBoundary.mock.calls[0][0]).toMatchObject({ charIndex: 6, name: "word" });
  });

  it("continues the queue when an utterance errors", () => {
    const synth = new FakeSynth();
    const onError = vi.fn();
    const tts = createWebSpeechTTS({ onError }, {}, makeDeps(synth));
    tts.speak("First. Second.");
    synth.startLatest();
    synth.spoken[0].onerror?.({ error: "interrupted" });
    expect(onError).toHaveBeenCalledTimes(1);
    // Errored utterance still advances to the next chunk.
    expect(synth.spoken.length).toBe(2);
  });
});

// --- estimated mouth envelope ----------------------------------------------

describe("WebSpeechTTS estimated mouth", () => {
  it("drives an estimated envelope during an utterance and silences after", () => {
    const synth = new FakeSynth();
    let t = 0;
    const deps = { ...makeDeps(synth), now: () => t };
    const mouthRef: { current: { open: number; viseme: string } | null } = {
      current: { open: 0, viseme: "viseme_sil" },
    };
    const tts = createWebSpeechTTS({}, { mouthRef }, deps);

    tts.speak("Hello there friend.");
    t = 0;
    synth.startLatest(); // records utterance start at t=0

    // Mid-utterance: the mouth is open with a non-silent viseme.
    t = 300;
    const mid = tts.currentMouth();
    expect(mid.volume).toBeGreaterThan(0);
    expect(mid.viseme).not.toBe("viseme_sil");

    // After the utterance ends, the mouth settles to silence.
    synth.endLatest();
    const done = tts.currentMouth();
    expect(done.volume).toBe(0);
    expect(done.viseme).toBe("viseme_sil");
    expect(mouthRef.current?.open).toBe(0);
  });
});

// --- voices ----------------------------------------------------------------

describe("WebSpeechTTS voices", () => {
  it("populates voices on voiceschanged and applies the selected voice", () => {
    const synth = new FakeSynth();
    const onVoicesChanged = vi.fn();
    const tts = createWebSpeechTTS({ onVoicesChanged }, {}, makeDeps(synth));

    expect(tts.getVoices()).toEqual([]);
    synth.voices = [voice("Alice", "en-US"), voice("Bob", "en-GB")];
    synth.fireVoicesChanged();
    expect(onVoicesChanged).toHaveBeenCalledTimes(1);
    expect(tts.getVoices().map((v) => v.name)).toEqual(["Alice", "Bob"]);

    tts.setVoice("Bob");
    tts.speak("Hi.");
    expect(synth.spoken[0].voice?.name).toBe("Bob");
  });
});

// --- availability ----------------------------------------------------------

describe("isWebSpeechAvailable", () => {
  const g = globalThis as { speechSynthesis?: unknown; SpeechSynthesisUtterance?: unknown };
  const origSynth = Object.getOwnPropertyDescriptor(globalThis, "speechSynthesis");
  const origUtter = Object.getOwnPropertyDescriptor(globalThis, "SpeechSynthesisUtterance");
  const restore = (key: string, desc: PropertyDescriptor | undefined) => {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete (g as Record<string, unknown>)[key];
  };
  afterEach(() => {
    restore("speechSynthesis", origSynth);
    restore("SpeechSynthesisUtterance", origUtter);
  });

  it("is false with no speechSynthesis and true when both primitives exist", () => {
    delete g.speechSynthesis;
    delete g.SpeechSynthesisUtterance;
    expect(isWebSpeechAvailable()).toBe(false);
    g.speechSynthesis = new FakeSynth();
    g.SpeechSynthesisUtterance = FakeUtterance;
    expect(isWebSpeechAvailable()).toBe(true);
  });
});
