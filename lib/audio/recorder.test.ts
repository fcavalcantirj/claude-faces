import { describe, expect, it, vi } from "vitest";
import {
  MicRecorder,
  RecorderError,
  negotiateMimeType,
  type RecorderDeps,
} from "@/lib/audio/recorder";

// --- Fakes -----------------------------------------------------------------
// jsdom has no getUserMedia / MediaRecorder, so we inject browser primitives.

function fakeTrack() {
  return { stop: vi.fn(), kind: "audio", readyState: "live" };
}

function fakeStream(): MediaStream {
  const tracks = [fakeTrack()];
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  } as unknown as MediaStream;
}

class FakeMediaRecorder {
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  startCalls: number[] = [];

  constructor(
    public stream: MediaStream,
    opts?: { mimeType?: string },
  ) {
    this.mimeType = opts?.mimeType ?? "";
  }

  start(timeslice?: number) {
    this.state = "recording";
    this.startCalls.push(timeslice ?? 0);
  }

  stop() {
    if (this.state !== "recording") return;
    this.state = "inactive";
    // A real MediaRecorder flushes a final chunk, then fires onstop.
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(8)], { type: this.mimeType || "audio/webm" }),
    });
    this.onstop?.();
  }

  /** Test helper: simulate a periodic timeslice chunk of `bytes`. */
  emit(bytes: number) {
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(bytes)], { type: this.mimeType || "audio/webm" }),
    });
  }
}

interface Harness {
  deps: RecorderDeps;
  created: FakeMediaRecorder[];
  getUserMedia: ReturnType<typeof vi.fn>;
  resumeAudio: ReturnType<typeof vi.fn>;
  timers: Array<{ fn: () => void; ms: number }>;
}

function makeHarness(over: Partial<RecorderDeps> = {}): Harness {
  const created: FakeMediaRecorder[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const getUserMedia = vi.fn(async () => fakeStream());
  const resumeAudio = vi.fn(async () => {});
  const deps: RecorderDeps = {
    getUserMedia,
    createRecorder: (stream, opts) => {
      const r = new FakeMediaRecorder(stream, opts);
      created.push(r);
      return r as unknown as MediaRecorder;
    },
    isTypeSupported: (mime: string) => mime === "audio/webm;codecs=opus",
    resumeAudio,
    setTimeout: ((fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length; // token
    }) as unknown as RecorderDeps["setTimeout"],
    clearTimeout: (() => {}) as unknown as RecorderDeps["clearTimeout"],
    ...over,
  };
  return { deps, created, getUserMedia, resumeAudio, timers };
}

// --- MIME negotiation ------------------------------------------------------

describe("negotiateMimeType", () => {
  it("prefers opus-in-webm when supported", () => {
    const mime = negotiateMimeType((m) => m === "audio/webm;codecs=opus");
    expect(mime).toBe("audio/webm;codecs=opus");
  });

  it("falls through to the next supported container", () => {
    const mime = negotiateMimeType((m) => m === "audio/mp4");
    expect(mime).toBe("audio/mp4");
  });

  it("returns empty string when nothing is supported (browser default)", () => {
    const mime = negotiateMimeType(() => false);
    expect(mime).toBe("");
  });
});

// --- Recording lifecycle ---------------------------------------------------

describe("MicRecorder", () => {
  it("records via hold-to-talk and yields a non-empty opus blob under the cap", async () => {
    const h = makeHarness();
    const rec = new MicRecorder({}, h.deps);

    await rec.start();
    expect(rec.getState()).toBe("recording");
    expect(rec.stream).not.toBeNull();
    expect(h.resumeAudio).toHaveBeenCalledOnce();

    const blob = await rec.stop();
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toContain("webm");
    expect(blob.size).toBeLessThan(4_500_000);
    expect(rec.getState()).toBe("idle");
  });

  it("requests the mic only once across repeated record cycles", async () => {
    const h = makeHarness();
    const rec = new MicRecorder({}, h.deps);

    await rec.start();
    await rec.stop();
    await rec.start();
    await rec.stop();

    expect(h.getUserMedia).toHaveBeenCalledOnce();
  });

  it("surfaces a denied-permission error as recoverable state, not a crash", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const h = makeHarness({
      getUserMedia: vi.fn(async () => {
        throw denied;
      }) as RecorderDeps["getUserMedia"],
    });
    const rec = new MicRecorder({}, h.deps);

    await expect(rec.start()).rejects.toBeInstanceOf(RecorderError);
    expect(rec.getState()).toBe("error");
    expect(rec.getError()?.kind).toBe("permission-denied");
    // No recorder was created — typing/other UI stays usable.
    expect(h.created).toHaveLength(0);
    // A later gesture can retry cleanly (rejects again, doesn't crash).
    await expect(rec.start()).rejects.toBeInstanceOf(RecorderError);
  });

  it("auto-stops and emits a result when the size cap is exceeded", async () => {
    const results: Blob[] = [];
    const h = makeHarness();
    const rec = new MicRecorder(
      { maxBytes: 1000, onResult: (b) => results.push(b) },
      h.deps,
    );

    await rec.start();
    const fake = h.created[0];
    // One oversized timeslice chunk crosses the cap.
    fake.emit(2000);

    // The auto-stop path flushes and finalizes without an awaited stop().
    await Promise.resolve();
    expect(fake.state).toBe("inactive");
    expect(results).toHaveLength(1);
    expect(results[0].size).toBeGreaterThan(0);
    expect(rec.getState()).toBe("idle");
  });

  it("auto-stops when the max duration elapses", async () => {
    const results: Blob[] = [];
    const h = makeHarness();
    const rec = new MicRecorder(
      { maxDurationMs: 30_000, onResult: (b) => results.push(b) },
      h.deps,
    );

    await rec.start();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(30_000);

    // Fire the scheduled auto-stop timer.
    h.timers[0].fn();
    await Promise.resolve();

    expect(rec.getState()).toBe("idle");
    expect(results).toHaveLength(1);
  });

  it("start() is idempotent while already recording", async () => {
    const h = makeHarness();
    const rec = new MicRecorder({}, h.deps);
    await rec.start();
    await rec.start();
    expect(h.created).toHaveLength(1);
    await rec.stop();
  });

  it("notifies state subscribers on transitions", async () => {
    const h = makeHarness();
    const rec = new MicRecorder({}, h.deps);
    const states: string[] = [];
    const unsub = rec.onStateChange((s) => states.push(s));

    await rec.start();
    await rec.stop();
    unsub();

    expect(states).toContain("recording");
    expect(states).toContain("idle");
  });

  it("dispose() stops the underlying tracks", async () => {
    const h = makeHarness();
    const rec = new MicRecorder({}, h.deps);
    await rec.start();
    const track = rec.stream!.getTracks()[0] as unknown as { stop: ReturnType<typeof vi.fn> };
    await rec.stop();
    rec.dispose();
    expect(track.stop).toHaveBeenCalled();
    expect(rec.stream).toBeNull();
  });

  it("throws a not-supported error when getUserMedia is unavailable", async () => {
    const rec = new MicRecorder({}, { getUserMedia: undefined });
    await expect(rec.start()).rejects.toMatchObject({ kind: "not-supported" });
    expect(rec.getState()).toBe("error");
  });
});
