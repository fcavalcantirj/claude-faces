// Insecure-origin (remote LAN/tailnet over plain HTTP) reproduction + UX eval.
//
// Felipe's live repro: the face served from a Pi at http://100.82.152.25:3000
// had a dead mic. The cause is browser secure-context policy, not hardware:
// on a plain-HTTP non-localhost origin the browser hides navigator.mediaDevices
// entirely AND ignores the COOP/COEP headers (no in-browser Whisper threads).
// This spec reproduces that against THIS machine's own LAN IPv4 and holds the
// UI to an honest, actionable explanation instead of a silent dead button.
//
// The chromium fake-media flags (fake UI / fake device) sit below the
// SecureContext IDL gate, so they do NOT force-define mediaDevices on an
// insecure origin — asserted directly below; if a future Chromium changes
// that, this spec fails loudly and needs a dedicated flag-free project.

import os from "node:os";
import { test, expect } from "@playwright/test";

// No mic permission grant here — the repro must run under real policy.
test.use({ permissions: [] });

const PORT = process.env.PLAYWRIGHT_PORT ?? "3000";

/** First non-internal IPv4 on this machine (the "remote" origin), if any. */
function lanIPv4(): string | null {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

/** Zero keys — the message under test is config-independent. */
const EMPTY_CONFIG = {
  providers: {},
  defaultProvider: null,
  agentBridge: { configured: false },
  stt: { groq: false, openai: false },
  tts: { openai: false },
};

test("plain-HTTP LAN origin: mediaDevices hidden, UI explains HTTPS remedy, typing alive", async ({
  page,
}) => {
  const ip = lanIPv4();
  test.skip(!ip, "no non-internal IPv4 interface on this machine");

  await page.route("**/api/config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_CONFIG),
    }),
  );

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  // CI runners have odd network shapes: an unreachable self-IP is a SKIP,
  // never a flake (the dev server may be bound to localhost only there).
  let navError: unknown = null;
  try {
    await page.goto(`http://${ip}:${PORT}/`, { timeout: 20_000 });
  } catch (err) {
    navError = err;
  }
  test.skip(navError !== null, `LAN origin http://${ip}:${PORT} unreachable: ${navError}`);

  // --- The reproduction: browser policy on an untrustworthy origin. ---------
  const policy = await page.evaluate(() => ({
    secureContext: window.isSecureContext,
    mediaDevices: typeof navigator.mediaDevices,
    isolated: self.crossOriginIsolated,
  }));
  expect(policy.secureContext).toBe(false);
  expect(policy.mediaDevices).toBe("undefined");
  expect(policy.isolated).toBe(false);

  // --- The UX: honest diagnosis + remedy, not a silent dead button. ---------
  const talk = page.getByRole("button", { name: /VOICE UNAVAILABLE/ });
  await expect(talk).toBeVisible({ timeout: 30_000 });
  await expect(talk).toBeDisabled();

  // Marker substrings only (copy-editable message, stable markers).
  const body = page.locator("body");
  await expect(body).toContainText("HTTPS");
  await expect(body).toContainText("localhost");
  await expect(body).toContainText("tailscale serve");

  // Degradation, not a dead end: the typed path stays open.
  await expect(page.getByPlaceholder("…or type a message")).toBeVisible();
  await expect(page.getByRole("button", { name: "SEND" })).toBeVisible();

  // No uncaught exceptions. (The COOP-ignored console message is EXPECTED on
  // this origin — it is the documented environmental symptom, not a bug.)
  expect(pageErrors, `uncaught: ${pageErrors.join(" | ")}`).toHaveLength(0);
});
