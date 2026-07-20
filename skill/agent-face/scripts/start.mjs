#!/usr/bin/env node
// start.mjs — ONE command: agent bridge (when present) + dev server + browser.
//
//   node start.mjs                 # full stack on :3000 (bridge on :8787)
//   node start.mjs --port 3100     # app on :3100
//   node start.mjs --yolo          # bridge in bypassPermissions (owner mode)
//   node start.mjs --stop          # tear the whole stack down
//   node start.mjs --take-port     # kill even a foreign port holder (default: refuse)
//
// Composition, not reinvention: the app half delegates to dev.mjs (which
// already port-kills, starts `npm run dev`, and opens the browser). This
// script adds the BRIDGE half — IF a local Claude Agent SDK bridge exists at
// <app-dir>/bridge (it ships with the claude-faces repo, deliberately NOT with
// this skill's app template: offering claude.ai login to third parties needs
// Anthropic approval; running YOUR OWN agent on your own machine is fine).
// With no bridge/ dir, this is dev.mjs with extra honesty: it says what you
// are missing and starts the app anyway (zero-key mode still gives a face).
//
// The bridge child env is SCRUBBED of ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
// — the bridge refuses to start when they are set (the CLI would silently
// bill metered instead of using the subscription), and the whole point of a
// one-command launcher is not stalling on that guard.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = join(HERE, "dev.mjs");

export const DEFAULT_APP_PORT = 3000;
export const DEFAULT_BRIDGE_PORT = 8787;

/** Parse argv (exported for tests). Throws on junk. */
export function parseStartArgs(argv) {
  const args = {
    port: DEFAULT_APP_PORT,
    bridgePort: DEFAULT_BRIDGE_PORT,
    bridge: true,
    yolo: false,
    open: true,
    stop: false,
    takePort: false,
    help: false,
    appDir: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--yolo") args.yolo = true;
    else if (a === "--no-bridge") args.bridge = false;
    else if (a === "--no-open") args.open = false;
    else if (a === "--stop") args.stop = true;
    else if (a === "--take-port") args.takePort = true;
    else if (a === "--port" || a === "--bridge-port") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`${a} needs a port number, got "${argv[i]}"`);
      }
      if (a === "--port") args.port = n;
      else args.bridgePort = n;
    } else if (!a.startsWith("-") && existsSync(a)) args.appDir = a;
    else throw new Error(`unknown option: ${a}`);
  }
  return args;
}

/** Bridge child env: parent env minus metered credentials, plus yolo mode. */
export function buildBridgeEnv(env, { yolo }) {
  const child = { ...env };
  delete child.ANTHROPIC_API_KEY;
  delete child.ANTHROPIC_AUTH_TOKEN;
  if (yolo) child.CLAUDE_BRIDGE_PERMISSION_MODE = "bypassPermissions";
  return child;
}

/**
 * Ensure .env.local wires the app to the local bridge. Appends ONLY missing
 * keys (an uncommented existing value — any value — is the user's choice and
 * is never touched). Returns the new content + what was added.
 */
export function ensureEnvLocalLines(content, bridgePort) {
  const has = (key) =>
    content.split("\n").some((line) => line.trim().startsWith(`${key}=`));
  const added = [];
  if (!has("AGENT_BRIDGE_KIND")) added.push("AGENT_BRIDGE_KIND=claude-code");
  if (!has("AGENT_BRIDGE_URL")) added.push(`AGENT_BRIDGE_URL=http://127.0.0.1:${bridgePort}`);
  if (added.length === 0) return { content, added };
  const sep = content.length && !content.endsWith("\n") ? "\n" : "";
  return { content: `${content}${sep}${added.join("\n")}\n`, added };
}

function usage() {
  console.log(`start.mjs — one command: agent bridge + dev server + browser.

Usage:
  node start.mjs [app-dir] [options]

Options:
  --port <n>         App port to free + serve on (default: ${DEFAULT_APP_PORT}).
  --bridge-port <n>  Bridge port (default: ${DEFAULT_BRIDGE_PORT}).
  --yolo             Bridge in bypassPermissions (owner's machine, no consent
                     clicks — a misheard sentence becomes an agent action).
  --no-bridge        Skip the bridge even if <app-dir>/bridge exists.
  --no-open          Don't open the browser.
  --stop             Stop this app's processes on the app + bridge ports, then
                     exit. A foreign process on either port is reported, not
                     killed (add --take-port to kill it too).
  --take-port        When freeing a port, kill even a holder that is NOT this
                     app's own process (default: refuse with exit 3).
  --help, -h         This help.

Behavior:
  1. If <app-dir>/bridge exists: installs its deps on first run, wires
     .env.local (appends ONLY missing AGENT_BRIDGE_* lines), frees the bridge
     port, starts the bridge with ANTHROPIC_API_KEY/AUTH_TOKEN scrubbed (the
     subscription-billing guard), and waits for /healthz.
  2. Delegates to dev.mjs: frees the app port, starts the dev server, opens
     the browser. Ctrl-C tears down both.
  Port freeing only auto-kills THIS app's own stale processes (identified by
  working directory / command line); anything else is refused — use
  --port / --bridge-port to move, or --take-port to override.
  No bridge dir? The app still starts — the face works with zero keys.`);
}

function teardownBridge(bridgeChild) {
  if (bridgeChild && bridgeChild.exitCode === null) bridgeChild.kill("SIGTERM");
}

async function waitForHealth(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Free a port via dev.mjs's guarded kill. cwd is the app dir so the guard
// knows which processes count as "this app's own"; exit 3 = foreign holder
// refused (see dev.mjs --take-port). Always returns a number: a spawn
// failure or signal death (status null) must read as failure, never as 0.
function killPort(port, appDir, takePort) {
  const argv = [DEV, "--kill-only", "--port", String(port)];
  if (takePort) argv.push("--take-port");
  const r = spawnSync("node", argv, { cwd: appDir, stdio: "inherit" });
  if (r.error) return 1;
  return r.status == null ? 1 : r.status;
}

async function main() {
  let args;
  try {
    args = parseStartArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err?.message ?? err));
    usage();
    process.exit(2);
  }
  if (args.help) {
    usage();
    return;
  }
  if (args.stop) {
    console.log(`Stopping: app :${args.port} + bridge :${args.bridgePort}`);
    const s1 = killPort(args.port, args.appDir, args.takePort);
    const s2 = killPort(args.bridgePort, args.appDir, args.takePort);
    const bad = [s1, s2].find((s) => s !== 0);
    if (bad !== undefined) process.exit(bad);
    return;
  }

  const bridgeDir = join(args.appDir, "bridge");
  const bridgeAvailable = existsSync(join(bridgeDir, "src", "server.mjs"));
  let bridgeChild = null;

  if (args.bridge && bridgeAvailable) {
    if (!existsSync(join(bridgeDir, "node_modules"))) {
      console.log("bridge: first run — npm install (Agent SDK)…");
      const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: bridgeDir,
        stdio: "inherit",
      });
      if (r.status !== 0) {
        console.error("bridge: npm install failed — starting the app WITHOUT the bridge.");
      }
    }

    const envPath = join(args.appDir, ".env.local");
    const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const wired = ensureEnvLocalLines(current, args.bridgePort);
    if (wired.added.length > 0) {
      writeFileSync(envPath, wired.content);
      console.log(`bridge: wired .env.local (+ ${wired.added.join(", ")})`);
    }

    const freed = killPort(args.bridgePort, args.appDir, args.takePort);
    if (freed !== 0) {
      console.error(
        `bridge: port ${args.bridgePort} is not available — ` +
          `pass --bridge-port <n>, or --take-port to kill its holder.`,
      );
      process.exit(freed);
    }
    console.log(`bridge: starting on :${args.bridgePort}${args.yolo ? " (yolo)" : ""}…`);
    bridgeChild = spawn("node", [join(bridgeDir, "src", "server.mjs")], {
      cwd: bridgeDir,
      env: {
        ...buildBridgeEnv(process.env, { yolo: args.yolo }),
        CLAUDE_BRIDGE_PORT: String(args.bridgePort),
      },
      stdio: "inherit",
    });
    const up = await waitForHealth(`http://127.0.0.1:${args.bridgePort}/healthz`);
    if (!up) {
      console.error("bridge: did not become healthy in 30s — continuing app-only.");
    }
  } else if (args.bridge && !bridgeAvailable) {
    console.log(
      "No bridge/ directory here — starting the face without a local agent " +
        "bridge (zero-key mode still works). To talk to YOUR OWN Claude Code " +
        "agent, use the claude-faces repo, which ships one (bridge/README.md).",
    );
  }

  // Fresh checkout / fresh scaffold: install the APP deps too (the audit's
  // finding — every documented path previously assumed node_modules existed).
  if (
    existsSync(join(args.appDir, "package.json")) &&
    !existsSync(join(args.appDir, "node_modules"))
  ) {
    console.log("app: first run — npm install…");
    const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: args.appDir,
      stdio: "inherit",
    });
    if (r.status !== 0) {
      console.error("app: npm install failed — cannot start the dev server.");
      teardownBridge(bridgeChild);
      process.exit(1);
    }
  }

  const devArgs = [DEV, "--port", String(args.port)];
  if (!args.open) devArgs.push("--no-open");
  if (args.takePort) devArgs.push("--take-port");
  const devChild = spawn("node", devArgs, { cwd: args.appDir, stdio: "inherit" });

  const teardown = () => {
    teardownBridge(bridgeChild);
    if (devChild.exitCode === null) devChild.kill("SIGTERM");
  };
  process.on("SIGINT", teardown);
  process.on("SIGTERM", teardown);
  devChild.on("exit", (code) => {
    teardown();
    process.exit(code ?? 0);
  });
}

const isDirectRun =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(String(err?.message ?? err));
    process.exit(1);
  });
}
