#!/usr/bin/env node
// deploy.mjs — deploy the Agent Face app to Vercel or build a self-host image.
//
// One script, two targets, the same preflight:
//
//   node skill/agent-face/scripts/deploy.mjs                        # Vercel (prod)
//   node skill/agent-face/scripts/deploy.mjs --target vercel --preview
//   node skill/agent-face/scripts/deploy.mjs --target self-host     # build + print run cmd
//   node skill/agent-face/scripts/deploy.mjs --target self-host --docker
//   node skill/agent-face/scripts/deploy.mjs --dry-run              # print the plan, run nothing
//   node skill/agent-face/scripts/deploy.mjs --help
//
// The app dir is the current directory when it holds a package.json (the usual
// scaffolded-app case), else the packaged assets/app-template resolved RELATIVE
// TO THIS SCRIPT, so it also works when the skill is extracted standalone.
//
// PREFLIGHT (both targets, BEFORE any network call or build): the required app
// files must exist — package.json, app/api/chat/route.ts,
// app/api/transcribe/route.ts, vercel.json. A missing file fails fast so we
// never start a partial deploy.
//
// No external deps, no harness-specific tooling — plain Node ESM +
// node:child_process/node:fs so any harness on any OS can run it. The Vercel
// path shells out to the `vercel` CLI (checked first); self-host shells out to
// `npm`/`docker` you already have.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET = "vercel";

// Files that MUST exist for the app to be deployable. Checked before anything
// touches the network — a broken scaffold fails here, not mid-deploy.
export const REQUIRED_APP_FILES = [
  "package.json",
  "app/api/chat/route.ts",
  "app/api/transcribe/route.ts",
  "vercel.json",
];

// Provider keys / agent-bridge vars — presence of ANY means the deploy will
// have a working brain. Absence is a WARNING (the app still boots on browser
// Whisper + Web Speech), never a hard failure.
const PROVIDER_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "AGENT_BRIDGE_URL",
  "HERMES_API_BASE_URL",
];

function help() {
  console.log(
    `deploy.mjs — deploy Agent Face to Vercel or build a self-host image.

Usage:
  node deploy.mjs [options]

Options:
  --target <vercel|self-host>   Where to deploy (default: ${DEFAULT_TARGET}).
  --prod                        Vercel: deploy to production (default).
  --preview                     Vercel: deploy a preview build instead of prod.
  --docker                      self-host: build a Docker image (else \`next build\`).
  --dry-run                     Print the plan and the run command; run nothing.
  --help, -h                    Show this help.

Targets:
  vercel      Verify the \`vercel\` CLI, link the project, typecheck, build, and
              \`vercel deploy\`. Prints the deployed URL + an HTTPS-mic reminder.
  self-host   \`npm run build\` (or \`docker build\`) then print the runnable
              \`docker compose up\` / \`next start\` command and how to point
              AGENT_BRIDGE_URL at your agent's private URL.

Every provider key is server-side only and optional; with zero keys the app
still runs on in-browser Whisper + Web Speech (a warning is printed, not an
error).`,
  );
}

export function parseArgs(argv) {
  const opts = {
    target: DEFAULT_TARGET,
    prod: true,
    docker: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--prod") opts.prod = true;
    else if (arg === "--preview") opts.prod = false;
    else if (arg === "--docker") opts.docker = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--target" || arg === "-t") {
      opts.target = normalizeTarget(argv[++i]);
    } else if (arg.startsWith("--target=")) {
      opts.target = normalizeTarget(arg.slice("--target=".length));
    } else {
      console.error(`✗ Unknown option: ${arg}\n`);
      help();
      process.exit(2);
    }
  }
  return opts;
}

function normalizeTarget(val) {
  if (val === "vercel" || val === "self-host") return val;
  console.error(
    `✗ Invalid --target: ${val ?? "(missing)"} — expected "vercel" or "self-host".`,
  );
  process.exit(2);
}

// The app dir is the current dir when it looks like a Next app, else the
// packaged template shipped next to this script.
export function resolveAppDir(cwd = process.cwd()) {
  if (existsSync(join(cwd, "package.json"))) return cwd;
  const template = join(HERE, "..", "assets", "app-template");
  if (existsSync(join(template, "package.json"))) return template;
  return cwd; // let preflight surface a clear missing-file error
}

// Pure preflight: which required files are missing under appDir.
export function preflight(appDir, requiredFiles = REQUIRED_APP_FILES) {
  const missing = requiredFiles.filter((f) => !existsSync(join(appDir, f)));
  return { ok: missing.length === 0, missing };
}

/** @param {Record<string, string | undefined>} [env] */
export function providerEnvPresent(env = process.env, vars = PROVIDER_ENV_VARS) {
  return vars.some((v) => {
    const val = env[v];
    return typeof val === "string" && val.trim() !== "";
  });
}

// The Vercel binary is overridable via VERCEL_BIN so a headless test can force
// "CLI absent" deterministically regardless of what's installed on the machine.
/** @param {Record<string, string | undefined>} [env] */
export function resolveVercelBin(env = process.env) {
  const bin = env.VERCEL_BIN;
  return bin && bin.trim() ? bin.trim() : "vercel";
}

// True when `<bin> --version` runs successfully.
export function commandAvailable(bin, versionArgs = ["--version"]) {
  const res = spawnSync(bin, versionArgs, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return !res.error && res.status === 0;
}

// The runnable command we print for a self-host build.
export function selfHostRunCommand({ docker }) {
  return docker
    ? "docker compose up --build     # serves http://localhost:${PORT:-3000}"
    : "npm run start                 # serves http://localhost:${PORT:-3000}";
}

// Run a command in the app dir, streaming output. Exits the process on failure
// so a deploy never proceeds past a broken step (no partial deploy).
function run(cmd, args, appDir, { dryRun }) {
  const printable = `${cmd} ${args.join(" ")}`.trim();
  if (dryRun) {
    console.error(`  [dry-run] would run: ${printable}`);
    return;
  }
  console.error(`\n$ ${printable}`);
  const res = spawnSync(cmd, args, {
    cwd: appDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.error) {
    console.error(`✗ Failed to run \`${printable}\`: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`✗ \`${printable}\` exited with code ${res.status}.`);
    process.exit(res.status || 1);
  }
}

function deployVercel(appDir, opts) {
  // 1) The vercel CLI must be present BEFORE any build/network step.
  const vercel = resolveVercelBin();
  if (!commandAvailable(vercel)) {
    console.error(
      `✗ The Vercel CLI is not installed (\`${vercel} --version\` failed).\n` +
        `  Install it first, then re-run:\n\n` +
        `    npm i -g vercel\n`,
    );
    process.exit(1);
  }
  console.error("✓ Vercel CLI detected.");

  // 2) Warn (do NOT fail) when no provider brain is configured.
  if (!providerEnvPresent()) {
    console.error(
      "⚠ No provider env detected (ANTHROPIC/OPENROUTER/GROQ/OPENAI/AGENT_BRIDGE).\n" +
        "  The app will still deploy and boot on in-browser Whisper + Web Speech,\n" +
        "  but no chat brain will answer until you add a key in the Vercel project\n" +
        "  env (Settings → Environment Variables) or wire a reachable agent-bridge.",
    );
  }

  // 3) Link (idempotent), verify, build, deploy.
  run(vercel, ["link", "--yes"], appDir, opts);
  run("npm", ["install"], appDir, opts);
  run("npm", ["run", "typecheck"], appDir, opts);
  run("npm", ["run", "build"], appDir, opts);

  const deployArgs = ["deploy"];
  if (opts.prod) deployArgs.push("--prod");
  run(vercel, deployArgs, appDir, opts);

  console.error(
    `\n✓ Deploy complete${opts.dryRun ? " (dry-run — nothing was deployed)" : ""}.\n` +
      "  Vercel prints the deployment URL above.\n" +
      "  Reminder: microphone capture requires HTTPS — the *.vercel.app URL is\n" +
      "  already HTTPS, so the mic works out of the box. Open it and press \"talk\".",
  );
}

function deploySelfHost(appDir, opts) {
  if (opts.docker) {
    // Build via compose so the image + run command stay in lock-step with
    // docker-compose.yml (no separately-tagged image to keep in sync).
    run("docker", ["compose", "build"], appDir, opts);
  } else {
    run("npm", ["install"], appDir, opts);
    run("npm", ["run", "build"], appDir, opts);
  }

  const cmd = selfHostRunCommand(opts);
  console.error(
    `\n✓ Self-host build complete${opts.dryRun ? " (dry-run — nothing was built)" : ""}.\n\n` +
      "Run it next to your agent:\n\n" +
      `    ${cmd}\n\n` +
      "Point the face at your running agent over the PRIVATE network (no tunnel):\n\n" +
      "    # in .env.local (read by docker-compose / next start)\n" +
      "    AGENT_BRIDGE_KIND=ollama\n" +
      "    AGENT_BRIDGE_URL=http://<agent-host-or-service>:<port>\n\n" +
      "Because the face runs on the same private network as the agent, Mode B\n" +
      "reaches it directly — see references/deploy.md for the full self-host guide.",
  );
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }

  const appDir = resolveAppDir();

  // PREFLIGHT — fail fast before any network call or build.
  const { ok, missing } = preflight(appDir);
  if (!ok) {
    console.error(
      `✗ Preflight failed — required app file(s) missing under:\n    ${appDir}\n` +
        missing.map((f) => `    - ${f}`).join("\n") +
        `\n  Run this from a scaffolded Agent Face app (see scaffold.mjs).`,
    );
    process.exit(1);
  }
  console.error(`✓ Preflight passed (app dir: ${appDir}).`);

  if (opts.target === "vercel") deployVercel(appDir, opts);
  else deploySelfHost(appDir, opts);
}

// Run only when executed directly, not when imported by a test.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
