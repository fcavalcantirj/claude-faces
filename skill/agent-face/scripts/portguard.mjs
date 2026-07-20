#!/usr/bin/env node
// portguard.mjs — identify who holds a TCP port before killing anything.
//
// dev.mjs frees its port before starting. The original behavior SIGKILLed
// whatever was listening — correct for THIS app's own stale servers,
// catastrophic for anything else (the neighbor project's dev server on the
// same port). This module classifies each occupant by asking the OS for its
// command line and working directory:
//
//   "ours"    — its cwd is inside the app dir, or its command line names the
//               app dir (a stale `next dev`, the bridge, a helper). Safe to
//               auto-kill.
//   "foreign" — identifiable, but belongs to something else. Refused by
//               default; --take-port overrides.
//   "unknown" — the OS gave us nothing (other user's process, Windows without
//               ps/lsof). Treated like foreign — never kill what you cannot
//               name.
//
// No external deps. Linux is inspected via /proc (no binaries needed);
// macOS via ps + lsof. All lookups are per-PID and read-only.

import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";

function capture(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) return null; // binary not present on this machine
  return res.stdout ?? "";
}

/** Parse `lsof -Fn` field output: the payload of the first `n` line. */
export function parseLsofCwd(out) {
  for (const line of (out ?? "").split("\n")) {
    if (line.startsWith("n")) return line.slice(1).trim() || null;
  }
  return null;
}

/** Best-effort {pid, command, cwd} for a PID; nulls where the OS won't say. */
export function describePid(pid) {
  let command = null;
  let cwd = null;
  if (!Number.isInteger(pid) || pid <= 0) return { pid, command, cwd };

  if (process.platform === "linux") {
    try {
      command =
        readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim() ||
        null;
    } catch {
      /* fall through to ps */
    }
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      /* fall through to lsof */
    }
  }

  if (!command && process.platform === "win32") {
    // No ps/lsof on Windows; CIM gives at least the command line (no cwd —
    // classification then rests on the command naming the app dir).
    const ps = capture("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ]);
    command = ps?.trim() || null;
    if (!command) {
      const wmic = capture("wmic", [
        "process", "where", `processid=${pid}`, "get", "commandline", "/format:list",
      ]);
      command = wmic?.match(/CommandLine=(.*)/)?.[1]?.trim() || null;
    }
  }

  if (!command) {
    const out = capture("ps", ["-o", "command=", "-p", String(pid)]);
    command = out?.trim() || null;
  }
  if (!cwd && process.platform !== "win32") {
    const out = capture("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    if (out !== null) cwd = parseLsofCwd(out);
  }

  return { pid, command, cwd };
}

/** True when `child` is `parent` or lives underneath it (no /app vs /app2 traps). */
export function isWithin(child, parent) {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// A command line "mentions" a dir only at a path boundary: the char after the
// match must be a separator (path continues INSIDE the dir), whitespace,
// quote, or end of string. `/app` must never match `/app2` or `app-v2`.
const BOUNDARY = new Set([undefined, "/", "\\", " ", "\t", '"', "'"]);
export function commandMentions(command, dir) {
  let at = -1;
  while ((at = command.indexOf(dir, at + 1)) !== -1) {
    if (BOUNDARY.has(command[at + dir.length])) return true;
  }
  return false;
}

/** "ours" | "foreign" | "unknown" for one occupant, relative to the app dir. */
export function classifyOccupant(info, appDir) {
  const app = real(appDir);
  if (info.cwd && isWithin(real(info.cwd), app)) return "ours";
  if (
    info.command &&
    (commandMentions(info.command, app) || commandMentions(info.command, resolve(appDir)))
  ) {
    return "ours";
  }
  if (!info.command && !info.cwd) return "unknown";
  return "foreign";
}

/**
 * Decide what to do about the port's occupants. Atomic: if ANY occupant is
 * not ours (and take is off), nothing is killed — killing only our share
 * would leave the port busy anyway, with half the evidence gone.
 * Returns { kill: pid[], refuse: [{pid, command, cwd, cls}] }.
 */
export function planPortAction(infos, appDir, { take = false } = {}) {
  if (take) return { kill: infos.map((i) => i.pid), refuse: [] };
  const refuse = [];
  for (const info of infos) {
    const cls = classifyOccupant(info, appDir);
    if (cls !== "ours") refuse.push({ ...info, cls });
  }
  if (refuse.length) return { kill: [], refuse };
  return { kill: infos.map((i) => i.pid), refuse: [] };
}
