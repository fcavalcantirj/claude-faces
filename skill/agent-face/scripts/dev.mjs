#!/usr/bin/env node
// dev.mjs — start the Agent Faces dev server, killing any previous one first.
//
// HARD REQUIREMENT (owner's standing rule): before starting a new dev server
// this script ALWAYS frees the dev port first — SIGTERM, then SIGKILL any
// survivor — so a stale `next dev` from a prior run can never collide with the
// new one. Only after the port is confirmed free does it spawn `npm run dev`.
//
//   node skill/agent-face/scripts/dev.mjs              # free :3000, start dev, open browser
//   node skill/agent-face/scripts/dev.mjs --port 4000  # use a different port
//   node skill/agent-face/scripts/dev.mjs --no-open    # don't open a browser
//   node skill/agent-face/scripts/dev.mjs --kill-only  # just free the port, don't start
//   node skill/agent-face/scripts/dev.mjs --take-port  # kill even a foreign holder
//   node skill/agent-face/scripts/dev.mjs --help
//
// The app dir is the current directory when it holds a package.json (the usual
// scaffolded-app case), else the packaged assets/app-template resolved RELATIVE
// TO THIS SCRIPT, so it also works when the skill is extracted standalone.
//
// Port freeing is PORT-SCOPED (never a broad `pkill next dev`) and, since the
// portguard change, IDENTITY-SCOPED too: only processes portguard.mjs can tie
// to THIS app (cwd inside the app dir, or a command line naming it) are
// auto-killed. Anything else holding the port makes this script refuse with
// exit 3 and the holder's identity — pass --port <n> to run elsewhere, or
// --take-port to kill the foreign process anyway.
//
// No external deps, no harness-specific tooling — plain Node ESM +
// node:child_process/node:net/node:fs so any harness on macOS/Linux/Windows
// can run it (lsof-based kill targets macOS/Linux per the task; Windows still
// gets the browser-open path).

import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { describePid, planPortAction } from "./portguard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3000;

function help() {
  console.log(
    `dev.mjs — free the dev port, then start the Agent Faces dev server.

Usage:
  node dev.mjs [options]

Options:
  --port <n>        Dev port to free + serve on (default: ${DEFAULT_PORT}).
  --no-open         Don't open a browser once the server is listening.
  --kill-only       Free the port and exit (don't start the dev server).
  --take-port       Kill the port's holder even when it is NOT this app's
                    own process (default: refuse and exit 3).
  --help, -h        Show this help.

Behavior:
  1. Frees the port first: kills a previous server OF THIS APP (identified by
     its working directory / command line) with SIGTERM, then SIGKILL if it
     survives. A foreign process holding the port is refused (exit 3) with
     its identity printed — use --port <n> or --take-port.
  2. Spawns \`npm run dev\` in the app dir (the current dir if it has a
     package.json, else the packaged app-template).
  3. When the server is listening, opens http://localhost:<port> (skipped in
     CI / headless environments or with --no-open). Ctrl-C stops it cleanly.`,
  );
}

export function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    open: true,
    killOnly: false,
    takePort: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--no-open") opts.open = false;
    else if (arg === "--kill-only") opts.killOnly = true;
    else if (arg === "--take-port") opts.takePort = true;
    else if (arg === "--port" || arg === "-p") {
      const val = argv[++i];
      opts.port = normalizePort(val);
    } else if (arg.startsWith("--port=")) {
      opts.port = normalizePort(arg.slice("--port=".length));
    } else {
      console.error(`✗ Unknown option: ${arg}\n`);
      help();
      process.exit(2);
    }
  }
  return opts;
}

function normalizePort(val) {
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`✗ Invalid --port value: ${val}`);
    process.exit(2);
  }
  return n;
}

// The app dir is the current dir when it looks like a Next app, else the
// packaged template shipped next to this script.
export function resolveAppDir(cwd = process.cwd()) {
  if (existsSync(join(cwd, "package.json"))) return cwd;
  const template = join(HERE, "..", "assets", "app-template");
  if (existsSync(join(template, "package.json"))) return template;
  return cwd; // let `npm run dev` surface a clear error
}

// PIDs holding a socket on the port, excluding our own process.
//
// STRATEGY CHAIN, because no single tool is universally present. The original
// implementation used lsof alone and returned [] when it was missing — which
// silently reported "port is free" and skipped the kill entirely. A stock
// node:22-bookworm image (i.e. a CI runner, or anyone's container) has NONE of
// lsof, ss, fuser or netstat, so on Linux that failure was the normal case, not
// an edge case. It is also the worst possible failure mode: not an error, just
// a quiet wrong answer.
//
//   1. lsof         — macOS and most Linux workstations
//   2. /proc         — pure Node, no external binary; works in bare containers
//   3. ss / fuser    — Linux boxes that have iproute2/psmisc but not lsof
//   4. netstat       — Windows
//
// Kept PORT-SCOPED throughout: we only ever stop whatever holds THIS port, never
// kill by process name, which would nuke unrelated projects' dev servers.

function runCapture(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) return null; // binary not present on this machine
  return res.stdout ?? "";
}

function cleanPids(pids) {
  const self = process.pid;
  return [...new Set(pids)].filter(
    (pid) => Number.isInteger(pid) && pid > 0 && pid !== self,
  );
}

/**
 * Pure-Node Linux lookup: find the listening socket's inode in /proc/net/tcp{,6},
 * then find which process holds a file descriptor pointing at that inode.
 * Needs no external binaries at all — the reason this fallback exists.
 */
function findPidsViaProc(port) {
  if (process.platform !== "linux" || !existsSync("/proc/net/tcp")) return null;

  const wantHex = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set();

  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(table)) continue;
    let lines;
    try {
      lines = readFileSync(table, "utf8").split("\n").slice(1);
    } catch {
      continue;
    }
    for (const line of lines) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      // f[1] = local_address "HEXIP:HEXPORT"; f[3] = state, 0A = LISTEN
      const localPort = f[1]?.split(":")[1];
      if (localPort !== wantHex || f[3] !== "0A") continue;
      const inode = Number(f[9]);
      if (Number.isInteger(inode) && inode > 0) inodes.add(inode);
    }
  }
  if (inodes.size === 0) return [];

  const targets = new Set([...inodes].map((i) => `socket:[${i}]`));
  const pids = [];
  let procDirs;
  try {
    procDirs = readdirSync("/proc");
  } catch {
    return null; // /proc unreadable — report "unknown", not "free"
  }

  for (const entry of procDirs) {
    if (!/^\d+$/.test(entry)) continue;
    let fds;
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue; // another user's process — not ours to inspect or kill
    }
    for (const fd of fds) {
      try {
        if (targets.has(readlinkSync(`/proc/${entry}/fd/${fd}`))) {
          pids.push(Number(entry));
          break;
        }
      } catch {
        /* fd vanished mid-scan */
      }
    }
  }
  return pids;
}

export function findPidsOnPort(port) {
  // 1. lsof — authoritative where present. Exits 1 with empty stdout when
  //    nothing matches, which is the genuine "port is free" case. LISTEN-
  //    scoped: without -sTCP:LISTEN, lsof also matches CLIENTS connected to
  //    the port (a browser tab on the dev server), and the port guard would
  //    refuse the whole kill because the browser is a foreign process.
  const lsofOut = runCapture("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
  if (lsofOut !== null) {
    return cleanPids(lsofOut.split("\n").map((s) => Number(s.trim())));
  }

  // 2. /proc — no external binary needed. This is what makes bare containers work.
  const procPids = findPidsViaProc(port);
  if (procPids !== null) return cleanPids(procPids);

  // 3. ss, then fuser — Linux hosts with iproute2/psmisc but no lsof.
  const ssOut = runCapture("ss", ["-lptnH", `sport = :${port}`]);
  if (ssOut) {
    const pids = [...ssOut.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    if (pids.length) return cleanPids(pids);
  }

  const fuserOut = runCapture("fuser", [`${port}/tcp`]);
  if (fuserOut) {
    return cleanPids(fuserOut.trim().split(/\s+/).map(Number));
  }

  // 4. Windows.
  if (process.platform === "win32") {
    const netstatOut = runCapture("netstat", ["-ano"]);
    if (netstatOut) {
      const pids = netstatOut
        .split("\n")
        .filter((l) => /LISTENING/i.test(l) && new RegExp(`[:.]${port}\\s`).test(l))
        .map((l) => Number(l.trim().split(/\s+/).pop()));
      return cleanPids(pids);
    }
  }

  // Nothing could inspect the port. Return empty (callers then rely on the
  // net-based free/busy probe), but say so — never imply a confident "free".
  console.warn(
    `  ! could not inspect port ${port}: no lsof, /proc, ss, fuser or netstat available`,
  );
  return [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false; // already gone / not permitted
  }
}

// Poll until the port has no owners or the deadline passes; returns whoever is
// still holding it.
async function waitForPortClear(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let pids = findPidsOnPort(port);
  while (pids.length && Date.now() < deadline) {
    await sleep(150);
    pids = findPidsOnPort(port);
  }
  return pids;
}

// An empty PID scan is NOT proof of freedom (field report: an orphaned
// next-server LISTENed while the scan said empty; "already free" then died
// as EADDRINUSE). Cross-check with a real TCP connect before declaring it.
async function assertReallyFree(port, log) {
  if (await canConnect(port)) {
    log(
      `✗ Port ${port} is occupied but no holder could be identified — ` +
        `refusing to pretend it is free. Find it (\`ss -ltnp\` / ` +
        `\`lsof -i tcp:${port}\`) and stop it, or use --port <n>.`,
    );
    process.exit(3);
  }
  log(`✓ Port ${port} is already free.`);
}

// The load-bearing step: guarantee the port is free before we start — but
// only auto-kill processes portguard can tie to THIS app. A foreign holder
// (another project's server) is refused with exit 3 unless takePort is set.
export async function freePort(port, log = console.error, guard = {}) {
  const { appDir = process.cwd(), takePort = false, findPids = findPidsOnPort } = guard;
  let initial = findPids(port);
  if (initial.length === 0) {
    await assertReallyFree(port, log);
    return;
  }

  // A PID can exit between the port scan and here; a vanished one must not
  // count as an unidentifiable foreign holder (spurious refusal). EPERM means
  // alive-but-not-ours-to-signal — keep it so the guard can refuse it.
  initial = initial.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err?.code === "EPERM";
    }
  });
  if (initial.length === 0) {
    await waitForPortClear(port, 1000);
    await assertReallyFree(port, log);
    return;
  }

  let infos = initial.map((pid) => describePid(pid));
  // A pid that died WHILE we were describing it reads as all-nulls (seen live:
  // --stop scanning the bridge port mid-teardown). Re-probe and drop ghosts
  // rather than refusing a process that no longer exists.
  infos = infos.filter((info) => {
    if (info.command || info.cwd) return true;
    try {
      process.kill(info.pid, 0);
      return true;
    } catch (err) {
      return err?.code === "EPERM";
    }
  });
  if (infos.length === 0) {
    await waitForPortClear(port, 1000);
    await assertReallyFree(port, log);
    return;
  }

  const plan = planPortAction(infos, appDir, { take: takePort });
  if (plan.refuse.length) {
    log(`✗ Port ${port} is held by process(es) that don't look like this app's:`);
    for (const r of plan.refuse) {
      const cmd = r.command ? r.command.slice(0, 120) : "(unidentified process)";
      log(`    PID ${r.pid} — ${cmd}${r.cwd ? `  (cwd: ${r.cwd})` : ""}`);
    }
    log(
      `  Refusing to kill them. Use --port <n> to run on another port, ` +
        `or --take-port to kill them anyway.`,
    );
    process.exit(3);
  }

  log(
    `Port ${port} is held by PID(s) ${plan.kill.join(", ")}${
      takePort ? "" : " (this app's own)"
    } — stopping them first…`,
  );
  for (const pid of plan.kill) killPid(pid, "SIGTERM");

  let remaining = await waitForPortClear(port, 2500);
  // Escalate ONLY on the pids we classified and SIGTERMed. A new process that
  // grabbed the port mid-free was never classified — it gets the refusal
  // treatment, never a blind SIGKILL.
  const escalate = remaining.filter((pid) => plan.kill.includes(pid));
  if (escalate.length) {
    log(`Still alive after SIGTERM — sending SIGKILL to ${escalate.join(", ")}…`);
    for (const pid of escalate) killPid(pid, "SIGKILL");
    remaining = await waitForPortClear(port, 2500);
  }

  const interlopers = remaining.filter((pid) => !plan.kill.includes(pid));
  if (interlopers.length) {
    log(
      `✗ Port ${port} was re-taken mid-free by PID(s) ${interlopers.join(", ")} — ` +
        `not killing an unclassified newcomer. Re-run, use --port <n>, or --take-port.`,
    );
    process.exit(3);
  }
  if (remaining.length) {
    log(
      `✗ Could not free port ${port}; PID(s) still listening: ${remaining.join(", ")}. ` +
        `Stop them manually or pick another --port.`,
    );
    process.exit(1);
  }
  log(`✓ Freed port ${port}.`);
}

// Skip opening a browser where there's nothing to open into.
export function isHeadless(env = process.env, platform = process.platform) {
  if (env.CI) return true;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  return false;
}

export function browserOpenArgv(url, platform = process.platform) {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

function openBrowser(url) {
  const [cmd, args] = browserOpenArgv(url);
  const res = spawnSync(cmd, args, { stdio: "ignore" });
  if (res.error) {
    console.error(
      `(Could not open a browser automatically — open ${url} yourself.)`,
    );
  }
}

function canConnect(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const finish = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.setTimeout(1000, () => finish(false));
  });
}

// Wait until the dev server accepts a TCP connection (up to timeoutMs).
async function waitForServer(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return true;
    await sleep(300);
  }
  return false;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }

  // 1) HARD REQUIREMENT — always free the port before doing anything else.
  //    The app dir is resolved first so the guard knows whose processes are
  //    fair game; anything else on the port is refused unless --take-port.
  const appDir = resolveAppDir();
  await freePort(opts.port, console.error, {
    appDir,
    takePort: opts.takePort,
  });

  if (opts.killOnly) return;

  // 2) Start the dev server in the resolved app dir.
  console.error(`Starting dev server in ${appDir} on port ${opts.port}…\n`);

  const child = spawn("npm", ["run", "dev", "--", "-p", String(opts.port)], {
    cwd: appDir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, PORT: String(opts.port) },
  });

  child.on("error", (err) => {
    console.error(`✗ Failed to start \`npm run dev\`: ${err.message}`);
    process.exit(1);
  });

  // Forward Ctrl-C / termination to the child so it stops cleanly.
  let shuttingDown = false;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      shuttingDown = true;
      if (child.pid) child.kill(sig);
    });
  }
  child.on("exit", (code, signal) => {
    if (shuttingDown) process.exit(0);
    process.exit(code ?? (signal ? 1 : 0));
  });

  // 3) Once it's listening, open the browser (unless headless / --no-open).
  if (opts.open && !isHeadless()) {
    const url = `http://localhost:${opts.port}`;
    waitForServer(opts.port).then((ready) => {
      if (ready && !shuttingDown) {
        console.error(`✓ Server listening — opening ${url}`);
        openBrowser(url);
      }
    });
  }
}

// Run only when executed directly, not when imported by a test.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
