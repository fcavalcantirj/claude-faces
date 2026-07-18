// STT accuracy smoke eval.
//
// This is an EVAL, not a unit test: lib/stt/index.test.ts already covers routing
// with fully fake engines. Here we push the REAL fixture clip (actual recorded
// speech, tests/fixtures/) through the REAL hosted client with only the network
// transport mocked, and score the transcript against a known ground truth.
//
// What is genuinely verified headlessly:
//   • the hosted path end-to-end (multipart build → response parse → SttResult),
//     with zero network and zero API spend
//   • auto-mode fallback when the browser worker fails, and the engine label
//   • the accuracy scorer itself, against known-good and known-bad transcripts
//
// What is NOT verifiable here (and is honestly deferred — see progress.txt UAT):
//   • real in-browser Whisper. transformers.js needs WebGPU/WASM threads, a Worker
//     and a ~50-150MB model download; jsdom has none of these. Asserting a real
//     whisper-base transcript requires a browser — tests/e2e/stt.spec.ts carries
//     that assertion, gated behind STT_REAL_MODEL=1.

import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";

import {
  transcribe,
  createHostedStt,
  SttError,
  type BrowserSttEngine,
  type HostedSttEngine,
} from "@/lib/stt";
import {
  SPEECH_WEBM,
  SPEECH_TRANSCRIPT,
  normalizeTranscript,
  transcriptAccuracy,
} from "./fixtures";

// --- fixture ----------------------------------------------------------------

/** The real recorded clip, as the Blob a MediaRecorder would hand us. */
function fixtureClip(): Blob {
  const bytes = readFileSync(SPEECH_WEBM);
  return new Blob([new Uint8Array(bytes)], { type: "audio/webm" });
}

/**
 * A fetch that answers /api/transcribe with a fixed transcript and /api/config
 * with hosted-STT-available. No network, no credits spent.
 */
function mockTranscribeFetch(
  transcriptText: string,
  { status = 200 }: { status?: number } = {},
) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);

    if (href.includes("/api/config")) {
      return new Response(JSON.stringify({ stt: { groq: true, openai: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (href.includes("/api/transcribe")) {
      // Prove the client actually shipped the audio rather than an empty body.
      const body = init?.body as FormData | undefined;
      const audio = body?.get?.("audio");
      if (!(audio instanceof Blob) || audio.size === 0) {
        return new Response(JSON.stringify({ error: "no audio received" }), { status: 400 });
      }

      if (status !== 200) {
        return new Response(JSON.stringify({ error: "upstream failed" }), { status });
      }

      return new Response(
        JSON.stringify({
          text: transcriptText,
          provider: "groq",
          model: "whisper-large-v3-turbo",
          latencyMs: 123,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

// --- the scorer itself ------------------------------------------------------
// If the scorer is wrong, every assertion below is meaningless — so test it first.

describe("transcript scoring", () => {
  it("scores a perfect transcript 1.0 regardless of case and punctuation", () => {
    expect(transcriptAccuracy(SPEECH_TRANSCRIPT, "The quick brown fox jumps over the lazy dog!")).toBe(1);
  });

  it("scores an unrelated transcript near zero", () => {
    expect(transcriptAccuracy(SPEECH_TRANSCRIPT, "completely different words entirely")).toBeLessThan(0.2);
  });

  it("degrades gracefully on a partially-correct transcript", () => {
    const score = transcriptAccuracy(SPEECH_TRANSCRIPT, "the quick brown fox sat down");
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(1);
  });

  it("normalizes casing, punctuation and whitespace", () => {
    expect(normalizeTranscript("  The   QUICK, brown fox!  ")).toBe("the quick brown fox");
  });
});

// --- hosted path (real client, mocked transport) ----------------------------

describe("hosted STT path", () => {
  it("transcribes the real fixture clip with no network and reports provenance", async () => {
    const fetchImpl = mockTranscribeFetch("The quick brown fox jumps over the lazy dog.");
    const hosted = createHostedStt({ fetchImpl });

    const result = await transcribe(fixtureClip(), { mode: "hosted" }, { hosted });

    expect(result.engine).toBe("hosted");
    expect(result.provider).toBe("groq");
    expect(result.model).toBe("whisper-large-v3-turbo");
    expect(result.latencyMs).toBe(123);
    expect(transcriptAccuracy(SPEECH_TRANSCRIPT, result.text)).toBe(1);

    // Exactly one POST to /api/transcribe — no stray calls, no real endpoint.
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const posts = calls.filter((c) => String(c[0]).includes("/api/transcribe"));
    expect(posts).toHaveLength(1);
  });

  it("sends the audio as multipart form data under the 'audio' field", async () => {
    const fetchImpl = mockTranscribeFetch("ok");
    const hosted = createHostedStt({ fetchImpl });

    // The mock 400s when the audio part is missing or empty, so a clean result
    // proves the clip really was attached.
    const result = await transcribe(fixtureClip(), { mode: "hosted" }, { hosted });
    expect(result.text).toBe("ok");
  });

  it("surfaces a typed SttError when the route fails", async () => {
    const fetchImpl = mockTranscribeFetch("unused", { status: 500 });
    const hosted = createHostedStt({ fetchImpl });

    await expect(transcribe(fixtureClip(), { mode: "hosted" }, { hosted })).rejects.toBeInstanceOf(
      SttError,
    );
  });
});

// --- auto fallback ----------------------------------------------------------

describe("auto mode fallback", () => {
  const workingHosted = (text: string): HostedSttEngine =>
    createHostedStt({ fetchImpl: mockTranscribeFetch(text) });

  it("falls back to hosted when the browser worker throws, and labels the engine", async () => {
    const browser: BrowserSttEngine = {
      isSupported: vi.fn(() => true),
      isModelCached: vi.fn(async () => true),
      transcribe: vi.fn(async () => {
        throw new Error("worker died: WebGPU adapter lost");
      }),
    };

    const result = await transcribe(
      fixtureClip(),
      { mode: "auto" },
      { browser, hosted: workingHosted("The quick brown fox jumps over the lazy dog.") },
    );

    expect(result.engine).toBe("hosted");
    expect(browser.transcribe).toHaveBeenCalledOnce();
    expect(transcriptAccuracy(SPEECH_TRANSCRIPT, result.text)).toBe(1);
  });

  it("uses the browser engine when it succeeds, and reports its backend", async () => {
    const browser: BrowserSttEngine = {
      isSupported: vi.fn(() => true),
      isModelCached: vi.fn(async () => true),
      transcribe: vi.fn(async () => ({
        text: "The quick brown fox jumps over the lazy dog.",
        backend: "webgpu" as const,
      })),
    };

    const result = await transcribe(
      fixtureClip(),
      { mode: "auto" },
      { browser, hosted: workingHosted("hosted should not be used") },
    );

    expect(result.engine).toBe("browser");
    expect(result.backend).toBe("webgpu");
    expect(transcriptAccuracy(SPEECH_TRANSCRIPT, result.text)).toBe(1);
  });

  it("falls back when the browser worker exceeds its timeout", async () => {
    const browser: BrowserSttEngine = {
      isSupported: vi.fn(() => true),
      isModelCached: vi.fn(async () => true),
      transcribe: vi.fn(
        () => new Promise(() => {}) as Promise<{ text: string; backend: "webgpu" }>,
      ),
    };

    const result = await transcribe(
      fixtureClip(),
      { mode: "auto", browserTimeoutMs: 20 },
      { browser, hosted: workingHosted("The quick brown fox jumps over the lazy dog.") },
    );

    expect(result.engine).toBe("hosted");
  });
});
