// @vitest-environment node
//
// The continuity digest: when the live SDK session is gone (bridge restarted,
// resume id stale), the replayed OpenAI history is compressed into a bounded
// text preamble so the fresh session knows what came before. Mirrors
// hermes-agent's _render_continuity_digest.

import { describe, it, expect } from "vitest";
import { buildContinuityDigest } from "../src/digest.mjs";

const msg = (role: string, content: string) => ({ role, content });

describe("buildContinuityDigest", () => {
  it("returns empty string when there is no prior conversation", () => {
    expect(buildContinuityDigest([])).toBe("");
    expect(buildContinuityDigest([msg("system", "be brief")])).toBe("");
  });

  it("includes role-labelled lines wrapped in digest markers", () => {
    const d = buildContinuityDigest([msg("user", "hello there"), msg("assistant", "hi!")]);
    expect(d).toMatch(/^\[Continuity digest/);
    expect(d).toContain("USER: hello there");
    expect(d).toContain("ASSISTANT: hi!");
    expect(d).toMatch(/\[End of continuity digest\]$/);
  });

  it("keeps only the tail of a long conversation", () => {
    const history = Array.from({ length: 30 }, (_, i) =>
      msg(i % 2 ? "assistant" : "user", `turn ${i}`),
    );
    const d = buildContinuityDigest(history, { tailTurns: 8 });
    expect(d).not.toContain("turn 21");
    expect(d).toContain("turn 22");
    expect(d).toContain("turn 29");
  });

  it("truncates individual messages and the whole digest", () => {
    const long = "x".repeat(10_000);
    const d = buildContinuityDigest([msg("user", long)], { perMessageChars: 100, maxChars: 400 });
    expect(d.length).toBeLessThanOrEqual(400 + "[End of continuity digest]".length + 1);
    expect(d).toContain("x".repeat(100));
    expect(d).not.toContain("x".repeat(101));
  });

  it("flattens array-of-parts content", () => {
    const d = buildContinuityDigest([
      { role: "user", content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] },
    ]);
    expect(d).toContain("part one");
    expect(d).toContain("part two");
  });

  it("skips system and tool messages", () => {
    const d = buildContinuityDigest([
      msg("system", "SYSTEM PROMPT"),
      msg("user", "q"),
      { role: "tool", content: "tool output" },
      msg("assistant", "a"),
    ]);
    expect(d).not.toContain("SYSTEM PROMPT");
    expect(d).not.toContain("tool output");
  });
});
