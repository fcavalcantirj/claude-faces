// Lip-sync eval on REAL audio, in a REAL browser.
//
// lib/lipsync.test.ts covers the engine's envelope maths headlessly against
// synthetic input. jsdom has no Web Audio, so what it CANNOT prove is the thing
// that actually matters: that a genuine recorded waveform, decoded and analysed
// by a genuine AnalyserNode, produces a non-flat envelope that rises on speech
// and decays to ~0 in silence. That is what this spec proves.
//
// The fixture (tests/fixtures/tts-sample.wav) is served to the page via
// page.route so nothing has to be copied into public/.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const TTS_WAV = fileURLToPath(new URL("../fixtures/tts-sample.wav", import.meta.url));
const FIXTURE_URL = "https://fixtures.test/tts-sample.wav";

/** Serve the local fixture at a stable URL the page can fetch. */
async function serveFixture(page: import("@playwright/test").Page) {
  const body = readFileSync(TTS_WAV);
  await page.route(FIXTURE_URL, (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", body }),
  );
}

test("a real waveform produces a non-flat envelope that tracks speech and silence", async ({
  page,
}) => {
  await serveFixture(page);
  await page.goto("/");

  const result = await page.evaluate(async (url) => {
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(analyser);
    // Deliberately NOT connected to ctx.destination — analyse without audible playback.

    // Record the REAL elapsed time of each sample. A loop iteration costs more
    // than its setTimeout, so assuming a fixed cadence and indexing by
    // (ms / interval) overruns the array — window by timestamp instead.
    const samples: { t: number; rms: number }[] = [];
    const data = new Float32Array(analyser.fftSize);

    src.start();
    const started = performance.now();
    // Sample across the clip plus ~800ms of trailing silence.
    while (performance.now() - started < buf.duration * 1000 + 800) {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      samples.push({ t: performance.now() - started, rms: Math.sqrt(sum / data.length) });
      await new Promise((r) => setTimeout(r, 25));
    }

    src.stop();
    const durationMs = buf.duration * 1000;
    await ctx.close();
    return { samples, durationMs };
  }, FIXTURE_URL);

  const { samples, durationMs } = result;
  expect(samples.length).toBeGreaterThan(20);

  const rms = samples.map((s) => s.rms);
  const peak = Math.max(...rms);
  const mean = rms.reduce((a, b) => a + b, 0) / rms.length;

  // 1. Speech is actually present — not silence, not a dead analyser.
  expect(peak).toBeGreaterThan(0.01);

  // 2. The envelope is NON-FLAT. A fixed sine or a stuck value would make peak
  //    and mean nearly equal; real speech has a wide dynamic range.
  expect(peak).toBeGreaterThan(mean * 1.5);

  // 3. Time alignment: the speech region is meaningfully louder than the
  //    trailing silence after the clip ends.
  const speechWindow = samples.filter((s) => s.t < durationMs * 0.8).map((s) => s.rms);
  const silenceWindow = samples.filter((s) => s.t > durationMs + 150).map((s) => s.rms);

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  expect(speechWindow.length).toBeGreaterThan(0);
  expect(silenceWindow.length).toBeGreaterThan(0);
  expect(avg(speechWindow)).toBeGreaterThan(0.005);
  expect(avg(silenceWindow)).toBeLessThan(avg(speechWindow) * 0.5);
});

test("silence produces a near-zero envelope", async ({ page }) => {
  await page.goto("/");

  const peak = await page.evaluate(async () => {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    // An empty buffer: genuinely silent input through the same graph.
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(analyser);
    src.start();

    const data = new Float32Array(analyser.fftSize);
    let max = 0;
    const started = performance.now();
    while (performance.now() - started < 400) {
      analyser.getFloatTimeDomainData(data);
      for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]));
      await new Promise((r) => setTimeout(r, 25));
    }
    src.stop();
    await ctx.close();
    return max;
  });

  expect(peak).toBeLessThan(0.001);
});

test("the mouth test hook is exposed under ?e2e=1 and rests closed in silence", async ({
  page,
}) => {
  await page.goto("/?e2e=1");

  // The skin mounts lazily (dynamic import of the R3F view), so poll for it.
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => typeof (window as unknown as { __agentFaceMouth?: unknown }).__agentFaceMouth,
        ),
      { message: "waiting for the Eidolon skin to mount", timeout: 30_000 },
    )
    .toBe("function");

  const mouth = await page.evaluate(() =>
    (window as unknown as { __agentFaceMouth: () => { open: number; viseme: string } })
      .__agentFaceMouth(),
  );

  expect(mouth).toHaveProperty("open");
  expect(mouth).toHaveProperty("viseme");
  // Nothing is speaking, so the mouth must be at rest — not stuck open, and not
  // oscillating on a fake sine.
  expect(mouth.open).toBeLessThan(0.05);
});

test("the mouth hook is NOT exposed without ?e2e=1", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(3_000);

  const exposed = await page.evaluate(
    () => typeof (window as unknown as { __agentFaceMouth?: unknown }).__agentFaceMouth,
  );
  expect(exposed).toBe("undefined");
});
