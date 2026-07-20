// Zero-key graceful-degradation eval.
//
// The promise this project makes is that with NO server keys at all the app is
// still useful: the face boots and animates, the failure is explained in words a
// human can act on, and the typing path stays open. This spec runs the app with
// /api/config mocked to report nothing configured and holds it to that.

import { test, expect, type Page } from "@playwright/test";

/** Zero keys, no agent bridge — the cold-start deployment. */
const EMPTY_CONFIG = {
  providers: {},
  defaultProvider: null,
  agentBridge: { configured: false },
  stt: { groq: false, openai: false },
  tts: { openai: false },
};

const CONFIGURED = {
  providers: {
    anthropic: { id: "anthropic", label: "Anthropic", mode: "A", available: true },
  },
  defaultProvider: "anthropic",
  agentBridge: { configured: false },
  stt: { groq: false, openai: false },
  tts: { openai: false },
};

async function mockConfig(page: Page, body: unknown) {
  await page.route("**/api/config", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
}

/**
 * Collect console errors and uncaught exceptions.
 *
 * KNOWN_TRACKED is now EMPTY, and that is the point. It briefly held two
 * entries — the hydration mismatch and the double createRoot — both surfaced by
 * this harness. Both were fixed rather than tolerated (the hydration one turned
 * out to be an uncaught exception, not a warning), so the allowance list emptied
 * itself and the spec still passes. An allowlist that never shrinks is a place
 * bugs go to be forgotten; keep this at zero.
 */
const KNOWN_TRACKED: RegExp[] = [];

function watchErrors(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  return {
    pageErrors,
    /** Console errors excluding the already-filed known issues. */
    unexpected: () => consoleErrors.filter((e) => !KNOWN_TRACKED.some((re) => re.test(e))),
    all: () => consoleErrors,
  };
}

test("boots with zero keys: face renders, no uncaught errors", async ({ page }) => {
  const errors = watchErrors(page);
  await mockConfig(page, EMPTY_CONFIG);

  await page.goto("/");

  // The face is never gated on keys — it must render regardless.
  const canvas = page.locator("canvas");
  await expect(canvas.first()).toBeVisible({ timeout: 30_000 });

  const box = await canvas.first().boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);

  // The speak-freely toggle exists even with zero keys — voice-in's zero-key
  // path is in-browser Whisper, so it is NOT asserted disabled here.
  await expect(page.getByRole("button", { name: /SPEAK FREELY/ })).toBeVisible();

  // Uncaught exceptions are never acceptable — this one is a hard gate.
  expect(errors.pageErrors, `uncaught: ${errors.pageErrors.join(" | ")}`).toHaveLength(0);
  expect(
    errors.unexpected(),
    `unexpected console errors: ${errors.unexpected().join(" | ")}`,
  ).toHaveLength(0);
});

test("explains the missing brain in actionable words and keeps typing available", async ({
  page,
}) => {
  await mockConfig(page, EMPTY_CONFIG);
  await page.goto("/");

  const body = page.locator("body");

  // Actionable: it must name the env vars a human can actually set.
  await expect(body).toContainText("No brain configured", { timeout: 30_000 });
  await expect(body).toContainText("ANTHROPIC_API_KEY");
  await expect(body).toContainText("AGENT_BRIDGE_URL");

  // The typing path stays present — degradation, not a dead end.
  await expect(page.getByPlaceholder("…or type a message")).toBeVisible();
  await expect(page.getByRole("button", { name: "SEND" })).toBeVisible();

  // Recovery is reload-based BY DECISION (Felipe, 2026-07-18): setting a server
  // key means redeploying or restarting anyway, so the user is already in a
  // reload-shaped moment, and polling every open tab forever to serve a
  // once-per-deployment event is a bad trade. That makes this wording
  // load-bearing — it is the ONLY thing telling the user how to recover. If
  // someone ever adds hot-recovery, this assertion should fail and be removed.
  await expect(body).toContainText("reload");
});

test("the particle face still animates with no keys", async ({ page }) => {
  await mockConfig(page, EMPTY_CONFIG);
  await page.goto("/?e2e=1");

  // The mouth hook proves the render loop is live rather than a frozen canvas.
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => typeof (window as unknown as { __agentFaceMouth?: unknown }).__agentFaceMouth,
        ),
      { message: "waiting for the skin to mount with zero keys", timeout: 30_000 },
    )
    .toBe("function");

  const mouth = await page.evaluate(() =>
    (window as unknown as { __agentFaceMouth: () => { open: number; viseme: string } })
      .__agentFaceMouth(),
  );
  expect(mouth).toHaveProperty("viseme");
});

test("with a brain configured the send flow works", async ({ page }) => {
  await mockConfig(page, CONFIGURED);
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        `data: ${JSON.stringify({ type: "delta", text: "I am awake." })}\n\n` +
        `data: ${JSON.stringify({ type: "done", reason: "stop" })}\n\n`,
    }),
  );

  await page.goto("/");

  // The no-brain banner must be gone when a brain IS configured.
  await expect(page.locator("body")).not.toContainText("No brain configured");

  await page.getByPlaceholder("…or type a message").fill("are you there?");
  await page.getByRole("button", { name: "SEND" }).click();

  await expect(page.locator("body")).toContainText("I am awake.", { timeout: 20_000 });
});

test("a denied mic surfaces a visible error toast and keeps typing open", async ({ page }) => {
  await mockConfig(page, EMPTY_CONFIG);
  // A secure context with a mic PRESENT but permission denied: the capability
  // gate keeps the button enabled, so the failure happens at press time — it
  // must surface as the red toast (reportMicError), never console-only.
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (md) {
      md.getUserMedia = () =>
        Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    }
  });
  await page.goto("/");

  const talk = page.getByRole("button", { name: /HOLD TO TALK/ });
  await expect(talk).toBeVisible({ timeout: 30_000 });
  await talk.dispatchEvent("pointerdown");

  // Marker substring of the existing RecorderError permission-denied message.
  await expect(page.locator("body")).toContainText("Microphone permission was denied", {
    timeout: 10_000,
  });
  await expect(page.getByPlaceholder("…or type a message")).toBeVisible();
});

// NOTE ON RECOVERY WITHOUT RELOAD
//
// The task text asks that enabling a brain restore the send flow "without
// reload". The current implementation does NOT support that, by design:
// lib/use-capabilities.ts fetches /api/config exactly ONCE on mount (a useEffect
// keyed only on injected config/fetch), and the app's own banner tells the user
// to "…then reload". There is no polling and no exposed refresh().
//
// Rather than quietly add a refresh path (app code nobody asked me to change) or
// assert a behaviour that does not exist, the recovery case above is verified
// the way the app actually works — configured brain, fresh load, send succeeds —
// and the gap is filed in prd.json as its own task.
