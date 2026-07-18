#!/usr/bin/env node
// smoke.mjs — dependency-free smoke tests for the Agent Face skill scripts.
//
// This exercises the SAFE paths of every skill script without a test framework,
// a browser, a real `next dev`, or a network deploy — so it runs anywhere Node
// runs (any harness, CI, headless). It is the runnable half of the skill's
// portability guarantee: if these pass, `scaffold` / `check-env` / `dev` /
// `deploy` behave as documented on this machine.
//
//   node skill/agent-face/scripts/test/smoke.mjs      # or: npm run test:skill
//
// What it covers:
//   scaffold.mjs  — copies the template into a temp dir; re-scaffolding a
//                   non-empty dir fails without --force and succeeds with it.
//   check-env.mjs — no keys => non-zero exit + crosses + no brain; a fake
//                   ANTHROPIC_API_KEY => exit 0 + Anthropic selected; and the
//                   secret VALUE is NEVER echoed (text or --json).
//   dev.mjs       — the port-kill logic in isolation: a throwaway listener on a
//                   real port is terminated by `dev --kill-only` (NO next dev).
//   deploy.mjs    — preflight fails fast on a dir missing app files; with the
//                   vercel CLI absent (VERCEL_BIN override) the install hint path
//                   is taken instead of any build/network step.
//
// Every temp dir is removed at the end (even on failure). Exit 0 iff all
// assertions pass; non-zero with a failure list otherwise.

import { spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url)); // scripts/test
const SCRIPTS = join(HERE, ".."); // scripts/
const SCAFFOLD = join(SCRIPTS, "scaffold.mjs");
const CHECK_ENV = join(SCRIPTS, "check-env.mjs");
const DEV = join(SCRIPTS, "dev.mjs");
const DEPLOY = join(SCRIPTS, "deploy.mjs");

// ---------------------------------------------------------------------------
// Tiny assertion + temp-dir bookkeeping (no framework).
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function check(name, cond, detail = "") {
  const suffix = detail ? ` — ${detail}` : "";
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${suffix}`);
    console.log(`  ✗ ${name}${suffix}`);
  }
}

const tmpDirs = [];
function mkTmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function cleanupTmp() {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort — reported by the leaked-dirs check below.
    }
  }
}

// Provider / bridge env vars we scrub so the "no keys" case is deterministic
// regardless of what the caller's shell already exports.
const SCRUB_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_DEFAULT_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_DEFAULT_MODEL",
  "GROQ_API_KEY",
  "GROQ_DEFAULT_MODEL",
  "OPENAI_API_KEY",
  "AGENT_BRIDGE_KIND",
  "AGENT_BRIDGE_URL",
  "AGENT_BRIDGE_KEY",
  "AGENT_BRIDGE_MODEL",
  "HERMES_API_BASE_URL",
  "HERMES_API_KEY",
  "SELF_HOST",
  "VERCEL",
  "VERCEL_ENV",
  "ALLOW_AGENT_BRIDGE_IN_PROD",
];
function cleanEnv(extra = {}) {
  const e = { ...process.env };
  for (const k of SCRUB_KEYS) delete e[k];
  return { ...e, ...extra };
}

function runNode(args, { cwd, env } = {}) {
  const res = spawnSync(process.execPath, args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { status: res.status, stdout, stderr, out: stdout + stderr };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(800, () => done(false));
  });
}

// A throwaway listener held by a SEPARATE process (dev.mjs excludes its own
// PID, and so would our PID if we listened in-process) — this is what the
// kill-logic test terminates.
let listenerChild = null;
let listenerExited = false;
function killListener() {
  if (listenerChild && !listenerExited) {
    try {
      listenerChild.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

async function testScaffold() {
  console.log("scaffold.mjs");
  const dest = join(mkTmp("smoke-scaffold-"), "app");

  let r = runNode([SCAFFOLD, dest]);
  check("scaffold exits 0", r.status === 0, `exit ${r.status}`);
  check("scaffold copies package.json", existsSync(join(dest, "package.json")));
  check("scaffold copies app/ dir", existsSync(join(dest, "app")));
  check("scaffold copies vercel.json", existsSync(join(dest, "vercel.json")));
  check(
    "scaffold skips node_modules",
    !existsSync(join(dest, "node_modules")),
  );

  r = runNode([SCAFFOLD, dest]);
  check(
    "re-scaffold without --force fails",
    r.status !== 0,
    `exit ${r.status}`,
  );
  check("re-scaffold failure explains non-empty target", /not empty/i.test(r.out));

  r = runNode([SCAFFOLD, dest, "--force"]);
  check("re-scaffold with --force succeeds", r.status === 0, `exit ${r.status}`);

  return dest; // reused by the deploy CLI-absent test (a complete app dir)
}

function testCheckEnv() {
  console.log("check-env.mjs");
  const emptyDir = mkTmp("smoke-env-"); // no .env / .env.local files

  // No keys anywhere => non-zero exit, all crosses, no brain selected.
  let r = runNode([CHECK_ENV, emptyDir], { env: cleanEnv() });
  check("check-env with no keys exits non-zero", r.status !== 0, `exit ${r.status}`);
  check("check-env with no keys prints crosses", r.out.includes("✗"));
  check(
    "check-env with no keys selects no brain",
    /Selected brain:\s*— none —/.test(r.out),
  );

  // A fake key => exit 0 + Anthropic selected, and the VALUE must never print.
  const SECRET = "sk-ant-SMOKE-DEADBEEF-must-never-be-printed";
  r = runNode([CHECK_ENV, emptyDir], {
    env: cleanEnv({ ANTHROPIC_API_KEY: SECRET }),
  });
  check("check-env with a key exits 0", r.status === 0, `exit ${r.status}`);
  check(
    "check-env selects Anthropic",
    /Selected brain:\s*Anthropic/.test(r.out),
  );
  check("check-env never echoes the secret value", !r.out.includes(SECRET));

  // --json is machine-readable but still must never leak the value.
  r = runNode([CHECK_ENV, emptyDir, "--json"], {
    env: cleanEnv({ ANTHROPIC_API_KEY: SECRET }),
  });
  check("check-env --json with a key exits 0", r.status === 0, `exit ${r.status}`);
  check("check-env --json never echoes the secret value", !r.out.includes(SECRET));
}

async function testDevKillLogic() {
  console.log("dev.mjs (port-kill logic in isolation)");
  const port = await getFreePort();

  // Hold the port from a separate node process (stays alive on a timer).
  listenerChild = spawn(
    process.execPath,
    [
      "-e",
      "const net=require('net');" +
        "net.createServer(c=>c.destroy()).listen(Number(process.env.SMOKE_PORT),'127.0.0.1');" +
        "setInterval(()=>{},1e9);",
    ],
    {
      env: { ...process.env, SMOKE_PORT: String(port) },
      stdio: "ignore",
    },
  );
  listenerChild.on("exit", () => {
    listenerExited = true;
  });

  const listening = await waitUntil(() => canConnect(port), 5000);
  check("throwaway server is listening on the port", listening, `port ${port}`);

  // `--kill-only` frees the port WITHOUT starting a real dev server.
  const r = runNode([DEV, "--kill-only", "--port", String(port)]);
  check("dev --kill-only exits 0", r.status === 0, `exit ${r.status}`);
  check(
    "dev reports it freed the port",
    /Freed port|already free/i.test(r.out),
  );

  const cleared = await waitUntil(async () => !(await canConnect(port)), 5000);
  check("dev --kill-only actually freed the port", cleared, `port ${port}`);
  // The listener was killed by dev.mjs (an external signal); wait for our own
  // 'exit' event to land rather than sampling exitCode synchronously.
  const exited = await waitUntil(() => listenerExited, 5000);
  check("the prior listener process was terminated", exited);
  killListener();
}

function testDeployPreflight(completeAppDir) {
  console.log("deploy.mjs (preflight + vercel-absent hint)");

  // A dir with a bare package.json (so resolveAppDir uses it) but missing the
  // required app files => preflight fails fast, before any build/network step.
  const bad = mkTmp("smoke-deploy-bad-");
  writeFileSync(
    join(bad, "package.json"),
    JSON.stringify({ name: "smoke-bad", private: true }),
  );
  let r = runNode([DEPLOY, "--target", "vercel", "--dry-run"], { cwd: bad });
  check(
    "deploy preflight fails on a dir missing app files",
    r.status !== 0,
    `exit ${r.status}`,
  );
  check("deploy preflight names the failure", /Preflight failed/i.test(r.out));

  // With a COMPLETE app dir but the vercel CLI absent (VERCEL_BIN override to a
  // bogus binary), deploy stops at the install-hint path — no build, no deploy.
  const SECRET = "sk-ant-SMOKE-DEPLOY-must-never-be-printed";
  r = runNode([DEPLOY, "--target", "vercel", "--dry-run"], {
    cwd: completeAppDir,
    env: cleanEnv({
      VERCEL_BIN: "smoke-nonexistent-vercel-binary",
      ANTHROPIC_API_KEY: SECRET,
    }),
  });
  check(
    "deploy fails when the vercel CLI is absent",
    r.status !== 0,
    `exit ${r.status}`,
  );
  check("deploy prints the install hint", /npm i -g vercel/.test(r.out));
  check("deploy never echoes a secret value", !r.out.includes(SECRET));
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log("Agent Face skill — script smoke tests\n");
  try {
    const completeAppDir = await testScaffold();
    console.log("");
    testCheckEnv();
    console.log("");
    await testDevKillLogic();
    console.log("");
    testDeployPreflight(completeAppDir);
  } catch (err) {
    failures.push(`unexpected error: ${err?.stack ?? err}`);
    console.log(`  ✗ unexpected error — ${err?.message ?? err}`);
  } finally {
    killListener();
    cleanupTmp();
  }

  console.log("");
  const leaked = tmpDirs.filter((d) => existsSync(d));
  check("all temp dirs removed", leaked.length === 0, leaked.join(", "));

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("✓ All skill script smoke tests passed.");
  process.exit(0);
}

main();
