// Real-model STT eval — the half of the STT smoke test that CANNOT run headlessly
// in vitest (tests/stt.smoke.test.ts covers the rest with mocked transport).
//
// This drives the genuine voice path: chromium's fake microphone replays
// tests/fixtures/speech-16k.wav (configured in playwright.config.ts), the app
// records it, transcribes it with real in-browser Whisper, and renders the
// transcript as a "YOU" turn. Nothing is mocked.
//
// SKIPPED BY DEFAULT. It needs a ~50-150MB whisper model download (or a hosted
// STT key) and WebGPU/WASM threads, which makes it slow and environment-
// dependent — wrong for a default CI gate, right for a deliberate eval run:
//
//   STT_REAL_MODEL=1 npx playwright test tests/e2e/stt.spec.ts
//
// With no model cached and no hosted key the app correctly reports voice as
// unavailable; that is the graceful-degradation path, asserted separately.

import { test, expect } from "@playwright/test";

const REAL_MODEL = process.env.STT_REAL_MODEL === "1";

// Content words from tests/fixtures/index.ts SPEECH_TRANSCRIPT. whisper-base is
// imperfect, so require key content words rather than a verbatim match.
const KEYWORDS = ["quick", "brown", "fox", "lazy", "dog"];

test.describe("real in-browser Whisper", () => {
  test.skip(!REAL_MODEL, "needs STT_REAL_MODEL=1 (downloads a Whisper model)");

  // Model download + first-run compile dominates; give it real headroom.
  test.setTimeout(10 * 60_000);

  test("transcribes the fake-mic utterance into a YOU turn", async ({ page }) => {
    await page.goto("/");

    const talk = page.getByRole("button", { name: /HOLD TO TALK|TAP TO LISTEN/ });
    await expect(talk).toBeEnabled({ timeout: 5 * 60_000 });

    // Hold slightly longer than the 2.5s fixture so the whole utterance lands.
    await talk.dispatchEvent("pointerdown");
    await page.waitForTimeout(3_500);
    await talk.dispatchEvent("pointerup");

    // The user turn appears as soon as recording stops, but its text is filled in
    // only once Whisper finishes — so poll the turn's CONTENT rather than
    // snapshotting the page the moment the label shows up. (Snapshotting early is
    // how this test first "failed": the HUD still read `transcribing`.)
    const userTurn = page.locator("div").filter({ hasText: /^YOU/ }).last();

    await expect
      .poll(
        async () => {
          const text = await userTurn.innerText().catch(() => "");
          return text.replace(/^YOU/, "").trim().length;
        },
        {
          message: "waiting for the in-browser Whisper transcript to land",
          timeout: 5 * 60_000,
          intervals: [1_000],
        },
      )
      .toBeGreaterThan(0);

    const transcript = (await userTurn.innerText()).toLowerCase();
    const found = KEYWORDS.filter((w) => transcript.includes(w));
    // Tolerant on purpose: whisper-base misses words, but it should not miss most.
    expect(
      found.length,
      `expected most of [${KEYWORDS.join(", ")}] in transcript: "${transcript}"`,
    ).toBeGreaterThanOrEqual(3);
  });
});
