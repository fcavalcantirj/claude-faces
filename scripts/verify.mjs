#!/usr/bin/env node
// The single definition of "green" for this project.
//
// WHY THIS EXISTS: CI must never be the only place the gates run. GitHub Actions
// can be unavailable for reasons that have nothing to do with the code — this
// repo's own workflow sat blocked behind an account billing lock, which would
// have left the project with no runnable definition of correctness at all. A
// contributor cloning this repo has no access to anyone's Actions account
// either.
//
// So the gates live HERE, in a plain Node script with no dependencies beyond the
// project's own, and .github/workflows/ci.yml simply calls it. That keeps local
// and CI from ever drifting: there is one list, and both read it.
//
//   npm run verify           # everything except the browser suite
//   npm run verify -- --e2e  # include Playwright (slower; needs a browser)
//   npm run verify -- --list # print the gates without running them
//
// Exit code is 0 only if every gate passed.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const WITH_E2E = args.includes("--e2e");
const LIST_ONLY = args.includes("--list");

// NODE_ENV is deliberately scrubbed for the build gate. A shell exporting
// NODE_ENV=development makes `next build` load React's dev build for part of the
// SSR graph and prod for the rest, nulling the dispatcher — prerendering then
// dies with "Cannot read properties of null (reading 'useContext')". That cost
// this project a full day of misdiagnosis. See references/troubleshooting.md.
const PROD_ENV = { ...process.env, NODE_ENV: "production" };
const CLEAN_ENV = { ...process.env };
delete CLEAN_ENV.NODE_ENV;

/** @type {{name: string, cmd: string, args: string[], env?: object, skip?: () => string|false}[]} */
const GATES = [
  {
    name: "lint",
    cmd: "npm",
    args: ["run", "lint"],
    env: CLEAN_ENV,
    skip: () =>
      existsSync("eslint.config.mjs") ? false : "no eslint.config.mjs (ESLint 9 needs one)",
  },
  { name: "typecheck", cmd: "npm", args: ["run", "typecheck"], env: CLEAN_ENV },
  { name: "unit tests + coverage", cmd: "npm", args: ["run", "test:coverage"], env: CLEAN_ENV },
  { name: "build", cmd: "npm", args: ["run", "build"], env: PROD_ENV },
  { name: "skill smoke tests", cmd: "npm", args: ["run", "test:skill"], env: CLEAN_ENV },
  {
    name: "app-template parity",
    cmd: "node",
    args: ["skill/agent-face/scripts/sync-template.mjs", "--check"],
    env: CLEAN_ENV,
  },
];

const E2E_GATE = {
  name: "browser e2e (playwright)",
  cmd: "npx",
  args: ["playwright", "test"],
  env: CLEAN_ENV,
};

const gates = WITH_E2E ? [...GATES, E2E_GATE] : GATES;

if (LIST_ONLY) {
  console.log(`${gates.length} gates:`);
  for (const g of gates) console.log(`  • ${g.name.padEnd(24)} ${g.cmd} ${g.args.join(" ")}`);
  console.log(WITH_E2E ? "" : "\n(browser e2e omitted — pass --e2e to include it)");
  process.exit(0);
}

console.log(`\nRunning ${gates.length} gates${WITH_E2E ? " (including browser e2e)" : ""}…\n`);

const results = [];
for (const gate of gates) {
  const skipReason = gate.skip?.();
  if (skipReason) {
    console.log(`── ${gate.name}: SKIPPED — ${skipReason}`);
    results.push({ name: gate.name, status: "skip", note: skipReason });
    continue;
  }

  process.stdout.write(`── ${gate.name} … `);
  const started = Date.now();
  const run = spawnSync(gate.cmd, gate.args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: gate.env ?? process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  // spawnSync sets .status to null when the process was killed by a signal.
  const ok = run.status === 0;
  console.log(ok ? `PASS (${secs}s)` : `FAIL (${secs}s)`);

  if (!ok) {
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trimEnd();
    console.log(out.split("\n").slice(-25).join("\n"));
    console.log("");
  }
  results.push({ name: gate.name, status: ok ? "pass" : "fail" });
}

const failed = results.filter((r) => r.status === "fail");
const skipped = results.filter((r) => r.status === "skip");

console.log("\n" + "─".repeat(52));
for (const r of results) {
  const mark = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "SKIP";
  console.log(`  ${mark}  ${r.name}${r.note ? ` — ${r.note}` : ""}`);
}
console.log("─".repeat(52));

if (failed.length) {
  console.log(`\n${failed.length} gate(s) FAILED: ${failed.map((f) => f.name).join(", ")}\n`);
  process.exit(1);
}
// A skipped gate is not a pass. Surface it rather than reporting a clean green.
console.log(
  `\nAll ${results.length - skipped.length} gates passed` +
    (skipped.length ? ` (${skipped.length} skipped — see above)` : "") +
    (WITH_E2E ? "" : "\nBrowser e2e not run; use `npm run verify -- --e2e` before releasing.") +
    "\n",
);
process.exit(0);
