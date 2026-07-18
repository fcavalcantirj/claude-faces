// Emotion lifecycle eval — the HUD flow half of the task.
//
// lib/face/emotion-machine.test.ts already covers nextEmotion() phase mapping,
// [[face:x]] directive override + stripping, keyword-sentiment fallback and
// transient decay, all headlessly. What it CANNOT cover is whether those
// transitions actually reach the screen during a real turn.
//
// This spec drives a full turn in a real browser with BOTH network seams mocked
// (/api/config so a brain looks configured, /api/chat so a scripted SSE stream
// stands in for a provider) and asserts the HUD STATE readout moves through the
// lifecycle and settles. No keys, no provider, no spend.

import { test, expect, type Page } from "@playwright/test";

/** The HUD renders `<dt>STATE</dt><dd>{label}</dd>`. */
const stateReadout = (page: Page) => page.locator('dt:has-text("STATE") + dd');

/** Report one configured chat brain so the UI treats chat as available. */
async function mockConfig(page: Page) {
  await page.route("**/api/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providers: {
          anthropic: { id: "anthropic", label: "Anthropic", mode: "A", available: true },
        },
        defaultProvider: "anthropic",
        agentBridge: { configured: false },
        stt: { groq: false, openai: false },
        tts: { openai: false },
      }),
    }),
  );
}

/**
 * Answer /api/chat with a scripted SSE stream, paced so the UI has time to
 * render `thinking` before the first token flips it to `speaking`.
 */
async function mockChat(page: Page, deltas: string[], { leadMs = 700 } = {}) {
  await page.route("**/api/chat", async (route) => {
    const frames = [
      ...deltas.map((t) => `data: ${JSON.stringify({ type: "delta", text: t })}\n\n`),
      `data: ${JSON.stringify({ type: "done", reason: "stop" })}\n\n`,
    ].join("");

    // A deliberate lead-in: without it the stream can complete before the HUD
    // ever paints the thinking state, and the test would assert nothing.
    await new Promise((r) => setTimeout(r, leadMs));

    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: frames,
    });
  });
}

async function sendMessage(page: Page, text: string) {
  await page.getByPlaceholder("…or type a message").fill(text);
  await page.getByRole("button", { name: "SEND" }).click();
}

test("HUD walks the lifecycle and settles on a resting emotion", async ({ page }) => {
  await mockConfig(page);
  await mockChat(page, ["Hello there. ", "How are you today?"]);
  await page.goto("/");

  await expect(stateReadout(page)).toHaveText("NEUTRAL");

  // Record every distinct state the HUD paints, so we assert on an ordered
  // sequence rather than racing a single point-in-time read.
  const seen: string[] = [];
  const stop = { done: false };
  const poller = (async () => {
    while (!stop.done) {
      const t = await stateReadout(page).textContent().catch(() => null);
      if (t && seen[seen.length - 1] !== t) seen.push(t);
      await page.waitForTimeout(60);
    }
  })();

  await sendMessage(page, "hello face");

  // THINKING must appear while the request is in flight.
  await expect(stateReadout(page)).toHaveText("THINKING", { timeout: 10_000 });
  // Then tokens arrive and it must move off THINKING.
  await expect(stateReadout(page)).not.toHaveText("THINKING", { timeout: 15_000 });

  stop.done = true;
  await poller;

  expect(seen[0]).toBe("NEUTRAL");
  expect(seen).toContain("THINKING");
  // The lifecycle must not stall in THINKING — something followed it.
  expect(seen.indexOf("THINKING")).toBeLessThan(seen.length - 1);
});

test("a [[face:happy]] directive drives the HUD to HAPPY and it RESTS there", async ({ page }) => {
  await mockConfig(page);
  await mockChat(page, ["That is wonderful news.", "[[face:happy]]"]);
  await page.goto("/");

  await sendMessage(page, "tell me something good");

  await expect(stateReadout(page)).toHaveText("HAPPY", { timeout: 20_000 });

  // It must STAY. A directive sets the RESTING emotion via restingEmotionForReply(),
  // so there is nothing for it to decay to — happy IS the destination.
  //
  // (I first asserted the opposite here and the test failed. `happy` is in
  // TRANSIENT_EMOTIONS, but that only governs a transient set by a LIFECYCLE
  // PHASE settling back onto the resting emotion — see the unit test, where a
  // transient happy decays onto a resting `love`. Transient decay is covered
  // there with fake timers, which is the right place for it.)
  await page.waitForTimeout(4_000); // comfortably past TRANSIENT_HOLD_MS (2200)
  await expect(stateReadout(page)).toHaveText("HAPPY");
});

test("the spoken transcript never contains the raw directive", async ({ page }) => {
  await mockConfig(page);
  await mockChat(page, ["All good here.", "[[face:happy]]"]);
  await page.goto("/");

  await sendMessage(page, "status?");

  const faceTurn = page.locator("div").filter({ hasText: /^FACE/ }).last();
  await expect(faceTurn).toContainText("All good here.", { timeout: 20_000 });

  const rendered = await faceTurn.innerText();
  expect(rendered).not.toContain("[[face:");
});
