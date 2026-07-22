// SKILL.md frontmatter must stay valid against Anthropic's official skill
// spec (skill-creator quick_validate) — a non-spec `version:` key slipped in
// and failed fleet validation (dasbrow's finding, GitHub issue #1, 2026-07-21).
// This is the dependency-free twin of that validator: it pins the allowed
// top-level keys so the gates catch a regression before any host does.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const SKILL_MD = join(dirname(fileURLToPath(import.meta.url)), "..", "SKILL.md");

/** Allowed top-level frontmatter keys per the official skill spec. */
const ALLOWED = new Set([
  "name",
  "description",
  "allowed-tools",
  "compatibility",
  "license",
  "metadata",
]);

function readFrontmatter(raw: string): { keys: string[]; body: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!m) throw new Error("SKILL.md has no frontmatter block");
  const body = m[1];
  // Top-level keys only: a key at column 0 (nested keys are indented).
  const keys = body
    .split("\n")
    .filter((l) => /^[A-Za-z][A-Za-z0-9_-]*\s*:/.test(l))
    .map((l) => l.split(":")[0].trim());
  return { keys, body };
}

describe("SKILL.md frontmatter (official skill-spec compliance)", () => {
  const raw = readFileSync(SKILL_MD, "utf8");
  const { keys, body } = readFrontmatter(raw);

  it("uses only spec-allowed top-level keys", () => {
    const illegal = keys.filter((k) => !ALLOWED.has(k));
    expect(illegal, `non-spec frontmatter keys: ${illegal.join(", ")} — nest under metadata:`).toEqual([]);
  });

  it("has the required name + description, and the name avoids reserved words", () => {
    expect(keys).toContain("name");
    expect(keys).toContain("description");
    const name = /^name\s*:\s*(.+)$/m.exec(body)?.[1] ?? "";
    expect(name.toLowerCase()).not.toContain("claude");
    expect(name.toLowerCase()).not.toContain("anthropic");
  });

  it("stays under the 500-line cap", () => {
    expect(raw.split("\n").length).toBeLessThanOrEqual(500);
  });
});
