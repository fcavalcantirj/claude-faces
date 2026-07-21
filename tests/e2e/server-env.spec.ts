// SERVER ENV view eval — READ-ONLY by design. No test here ever performs a
// real save: the Playwright webServer runs against the developer's own
// .env.local, and a write would clobber their keys. The full write matrix is
// unit-tested in lib/settings/env-admin.test.ts against an injected fs; the
// browser flows covered here are navigation, ordering, guidance, and the
// unlock/401 path against a MOCKED /api/env.

import { test, expect, type Page } from "@playwright/test";

async function openServerEnv(page: Page) {
  await page.goto("/");
  await page.getByLabel("Open settings").click();
  await page.getByRole("button", { name: "SERVER ENV" }).click();
  await expect(page.getByRole("heading", { name: "SERVER ENV" })).toBeVisible();
}

test("unprovisioned localhost: first-run CREATE PASSWORD form renders (never submitted here)", async ({
  page,
}) => {
  // The dev rig has no FACE_SETTINGS_PASSWORD_HASH → localhost GET offers
  // bootstrap. This spec must NOT submit the form — it would provision the
  // developer's real .env.local; the write path is unit-covered.
  await openServerEnv(page);
  await expect(page.locator("aside")).toContainText("First run", { timeout: 10_000 });
  await expect(page.getByPlaceholder("new settings password (min 12 chars)")).toBeVisible();
  await expect(page.getByPlaceholder("repeat it")).toBeVisible();
  // Guard: CREATE stays disabled until both fields reach 12 chars.
  const create = page.getByRole("button", { name: "CREATE PASSWORD" });
  await expect(create).toBeDisabled();
  await page.getByPlaceholder("new settings password (min 12 chars)").fill("short");
  await expect(create).toBeDisabled();
  // The inventory still renders (all rows unset) so the user sees what exists.
  await expect(page.locator("aside")).toContainText("ANTHROPIC_API_KEY");
  await expect(page.locator("aside")).toContainText("CLAUDE_CODE_OAUTH_TOKEN");
});

test("used-first ordering and the wrong-password 401 path (mocked /api/env)", async ({
  page,
}) => {
  await page.route("**/api/env", async (route) => {
    const req = route.request();
    if (req.headers()["authorization"]) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "unauthorized", message: "Wrong settings password." } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        writable: true,
        unlocked: false,
        vars: {
          OPENAI_API_KEY: { set: true },
          AGENT_BRIDGE_KIND: { set: true },
        },
      }),
    });
  });

  await openServerEnv(page);

  // Used-first: the SET vars lead; unset tier-1 rows follow.
  const text = await page.locator("aside").innerText();
  const pos = (needle: string) => text.indexOf(needle);
  expect(pos("OPENAI_API_KEY")).toBeGreaterThan(-1);
  expect(pos("OPENAI_API_KEY")).toBeLessThan(pos("ANTHROPIC_API_KEY"));
  expect(pos("AGENT_BRIDGE_KIND")).toBeLessThan(pos("ANTHROPIC_API_KEY"));
  await expect(page.locator("aside")).toContainText("● SET");

  // SHOW ALL reveals the knob tier + the read-only deploy gates.
  await page.getByRole("button", { name: /SHOW ALL/ }).click();
  await expect(page.locator("aside")).toContainText("OPENAI_TTS_VOICE");
  await expect(page.locator("aside")).toContainText("DEPLOY (READ-ONLY)");
  await expect(page.locator("aside")).toContainText("SELF_HOST");

  // Unlock with a wrong password → inline 401 message, still locked.
  await page.getByPlaceholder("settings password").fill("not-the-password");
  await page.getByRole("button", { name: "UNLOCK" }).click();
  await expect(page.locator("aside")).toContainText("Wrong password.");
  await expect(page.locator("aside")).not.toContainText("UNLOCKED");
});
