// Client/server boundary guard.
//
// app/page.tsx is a 'use client' component. Anything it can reach — transitively,
// through VALUE imports — is compiled into the browser bundle. Provider adapters
// must never be reachable that way: they exist to hold server credentials and
// speak to provider APIs, and the browser's only route to a brain is /api/chat.
//
// This walks the real import graph from the client entrypoints and fails if a
// provider SDK is reachable. It is a static analysis on purpose: it catches the
// regression at test time rather than waiting for someone to notice a 151KB
// chunk, and it does not depend on a build having run.
//
// TYPE-ONLY imports are correctly ignored — `import type { X }` is erased by the
// compiler and never reaches the bundle.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { describe, it, expect } from "vitest";

// vitest's root is the repo root (vitest.config.ts lives there), so cwd is the
// reliable anchor here — import.meta.url is not a file: URL under the transform.
const ROOT = process.cwd() + "/";

/** Entrypoints that end up in the browser bundle. */
const CLIENT_ENTRYPOINTS = ["app/page.tsx", "lib/use-orchestrator.ts", "lib/orchestrator.ts"];

/** Modules that must NEVER be reachable from the client. */
const FORBIDDEN = [
  "@anthropic-ai/sdk",
  // The Agent SDK (bridge/ dev tool) — a separate entry because the endsWith
  // check below does NOT subsume it under "@anthropic-ai/sdk".
  "@anthropic-ai/claude-agent-sdk",
  "lib/providers/anthropic",
  "lib/providers/openrouter",
  "lib/providers/groq",
  "lib/providers/agent-bridge",
];

const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx"];

/** Resolve a specifier to a repo-relative file, or null if external/unresolvable. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(join(ROOT, fromFile)), spec);
  else return null; // bare package — not a local file

  for (const ext of ["", ...EXTENSIONS]) {
    const candidate = base + ext;
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      try {
        if (readFileSync(candidate).length >= 0) return candidate.slice(ROOT.length);
      } catch {
        /* directory */
      }
    }
  }
  for (const ext of EXTENSIONS) {
    const candidate = join(base, "index" + ext);
    if (existsSync(candidate)) return candidate.slice(ROOT.length);
  }
  return null;
}

interface Import {
  spec: string;
  typeOnly: boolean;
}

/**
 * Extract import specifiers, flagging type-only ones so they can be ignored.
 * Handles `import type {...} from 'x'` and `export ... from 'x'` re-exports.
 */
function importsOf(relPath: string): Import[] {
  const src = readFileSync(join(ROOT, relPath), "utf8");
  const out: Import[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const clause = m[2];
    out.push({ spec: m[3], typeOnly: /^\s*type\b/.test(clause) });
  }
  // Bare side-effect imports: `import 'x'`
  const bare = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  while ((m = bare.exec(src))) out.push({ spec: m[1], typeOnly: false });
  return out;
}

interface Hit {
  forbidden: string;
  path: string[];
}

/** BFS the value-import graph from an entrypoint, returning any forbidden reach. */
function findForbiddenReach(entry: string): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  const queue: { file: string; trail: string[] }[] = [{ file: entry, trail: [entry] }];

  while (queue.length) {
    const { file, trail } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const imp of importsOf(file)) {
      if (imp.typeOnly) continue; // erased at compile time — never bundled

      const forbidden = FORBIDDEN.find(
        (f) => imp.spec === f || imp.spec === `@/${f}` || imp.spec.endsWith(f),
      );
      if (forbidden) {
        hits.push({ forbidden, path: [...trail, imp.spec] });
        continue;
      }

      const resolved = resolveSpecifier(imp.spec, file);
      if (resolved && !seen.has(resolved)) queue.push({ file: resolved, trail: [...trail, resolved] });
    }
  }
  return hits;
}

describe("client bundle boundary", () => {
  it.each(CLIENT_ENTRYPOINTS)("%s cannot reach a provider SDK", (entry) => {
    const hits = findForbiddenReach(entry);
    const report = hits.map((h) => `${h.forbidden} via ${h.path.join(" -> ")}`).join("\n  ");
    expect(hits, hits.length ? `forbidden reach:\n  ${report}` : "").toEqual([]);
  });

  it("the walker actually works (guards against a vacuous pass)", () => {
    // app/api/chat/route.ts is SERVER code and legitimately reaches the adapters.
    // If the walker cannot see that, it cannot see a real regression either.
    const hits = findForbiddenReach("app/api/chat/route.ts");
    expect(hits.length).toBeGreaterThan(0);
  });
});
