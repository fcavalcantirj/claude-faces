// prd.json integrity guard.
//
// prd.json is the project deliverable, not just a scratch todo list: the Ralph
// loop reads it every iteration, progress.sh and uat.sh derive their output from
// it, and a human is meant to be able to execute it top-to-bottom. A malformed
// entry silently breaks all three, so the shape is asserted here rather than
// trusted.
//
// The headless_verifiable flag is deliberately NOT asserted per-task — it is a
// fixed human-assigned label and no test should imply an agent may retune it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const VALID_CATEGORIES = new Set(["backend", "frontend", "docs", "skill", "infra"]);
const REQUIRED_KEYS = ["category", "description", "headless_verifiable", "passes", "steps"];

const raw = readFileSync(join(process.cwd(), "prd.json"), "utf8");

describe("prd.json", () => {
  it("is a bare JSON array", () => {
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  const tasks = JSON.parse(raw) as Record<string, unknown>[];

  it("every task has EXACTLY the five required keys", () => {
    const offenders = tasks
      .map((t, i) => ({ n: i + 1, keys: Object.keys(t).sort() }))
      .filter((t) => JSON.stringify(t.keys) !== JSON.stringify(REQUIRED_KEYS));
    expect(offenders, `tasks with wrong keys: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it("every category is one of the five allowed values", () => {
    const offenders = tasks
      .map((t, i) => ({ n: i + 1, category: t.category }))
      .filter((t) => !VALID_CATEGORIES.has(t.category as string));
    expect(offenders, `invalid categories: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it("every task carries at least one Verify: step", () => {
    const offenders = tasks
      .map((t, i) => ({ n: i + 1, description: String(t.description).slice(0, 50) }))
      .filter((_, i) => {
        const steps = tasks[i].steps as string[];
        return !Array.isArray(steps) || !steps.some((s) => s.startsWith("Verify:"));
      });
    expect(offenders, `tasks with no Verify: step: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it("passes and headless_verifiable are booleans, never truthy strings", () => {
    const offenders = tasks
      .map((t, i) => ({ n: i + 1, passes: typeof t.passes, hv: typeof t.headless_verifiable }))
      .filter((t) => t.passes !== "boolean" || t.hv !== "boolean");
    expect(offenders, `non-boolean flags: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it("reserves the URGENT marker for genuinely critical work", () => {
    // The marker means "do this first". If everything is urgent, nothing is.
    const urgent = tasks.filter((t) => /URGENT/.test(String(t.description)));
    expect(urgent.length).toBeLessThanOrEqual(3);
  });

  it("descriptions are unique, so progress and UAT lines are unambiguous", () => {
    const seen = new Map<string, number>();
    const dupes: string[] = [];
    tasks.forEach((t) => {
      const d = String(t.description);
      if (seen.has(d)) dupes.push(d);
      seen.set(d, (seen.get(d) ?? 0) + 1);
    });
    expect(dupes, `duplicate descriptions: ${dupes.join(", ")}`).toEqual([]);
  });
});
