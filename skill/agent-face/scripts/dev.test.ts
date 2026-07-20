// dev.test.ts — headless coverage for the dev-with-kill script.
//
// The full behavior (spawning `next dev` + opening a browser + a face
// rendering) needs a human/browser and is deferred to UAT. What we CAN verify
// headlessly is the HARD REQUIREMENT: dev.mjs frees the port first, killing any
// process already listening on it. We prove that by starting a decoy listener
// in a separate process and asserting `dev.mjs --kill-only` takes it down and
// leaves the port free — plus the CLI contract (--help, bad args).

import { describe, it, expect } from "vitest";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = join(HERE, "dev.mjs");

function runDev(args: string[]) {
  return spawnSync("node", [DEV, ...args], { encoding: "utf8" });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

// A listener in a SEPARATE process (so killing it can't take down this test).
// `cwd` controls how the port guard classifies it: inside the app dir = "ours"
// (auto-killed), anywhere else = "foreign" (refused without --take-port).
function spawnDecoy(port: number, cwd?: string): Promise<ChildProcess> {
  const code =
    `const net=require('net');` +
    `net.createServer().listen(${port},'127.0.0.1',()=>process.stdout.write('READY'));` +
    `setInterval(()=>{},1e9);`;
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["-e", code], {
      stdio: ["ignore", "pipe", "ignore"],
      cwd,
    });
    const timer = setTimeout(() => reject(new Error("decoy never listened")), 5000);
    child.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("READY")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("error", reject);
  });
}

// Use dev.mjs's OWN port lookup rather than shelling out to lsof here.
//
// This helper previously called `lsof -ti` directly, which duplicated the very
// dependency the script was fixed to stop relying on. On any machine without
// lsof — a stock node:22 container, i.e. a CI runner — it returned [] and the
// test's own SANITY CHECK failed ("expected 0 to be greater than 0") before the
// real assertion ever ran. The test was macOS-only while claiming to verify
// portable behaviour.
//
// Importing the real function also means this test now exercises the shipped
// lookup (lsof → /proc → ss/fuser → netstat) instead of a parallel imitation of
// it. dev.mjs guards its CLI entry, so importing has no side effects.
async function portOwners(port: number): Promise<number[]> {
  const { findPidsOnPort } = await import("./dev.mjs");
  return findPidsOnPort(port);
}

describe("dev.mjs CLI contract", () => {
  it("--help prints usage (mentioning the kill step) and exits 0", () => {
    const res = runDev(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("dev.mjs");
    expect(res.stdout.toLowerCase()).toContain("kill");
  });

  it("rejects an unknown option with a non-zero exit", () => {
    const res = runDev(["--bogus"]);
    expect(res.status).toBe(2);
  });

  it("rejects an invalid --port with a non-zero exit", () => {
    const res = runDev(["--port", "not-a-port", "--kill-only"]);
    expect(res.status).toBe(2);
  });
});

describe("dev.mjs frees the port before starting", () => {
  it("--kill-only kills a process already listening on the port", async () => {
    const port = await getFreePort();
    const decoy = await spawnDecoy(port);
    try {
      // Sanity: the decoy really is holding the port.
      expect((await portOwners(port)).length).toBeGreaterThan(0);

      const res = runDev(["--kill-only", "--no-open", "--port", String(port)]);
      expect(res.status).toBe(0);

      // dev.mjs only exits after the port is confirmed clear.
      expect(await portOwners(port)).toEqual([]);
      expect(res.stderr.toLowerCase()).toContain("freed port");
    } finally {
      decoy.kill("SIGKILL");
    }
  }, 15000);

  it("--kill-only on an already-free port succeeds without error", async () => {
    const port = await getFreePort();
    const res = runDev(["--kill-only", "--no-open", "--port", String(port)]);
    expect(res.status).toBe(0);
    expect(res.stderr.toLowerCase()).toContain("free");
  }, 15000);
});

// A client with an ESTABLISHED connection to the port, in a separate process
// with a FOREIGN cwd — the shape of a browser tab attached to a dev server.
function spawnClient(port: number): Promise<ChildProcess> {
  const code =
    `const net=require('net');` +
    `const s=net.connect(${port},'127.0.0.1',()=>process.stdout.write('CONNECTED'));` +
    `s.on('error',()=>process.exit(1));setInterval(()=>{},1e9);`;
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["-e", code], {
      stdio: ["ignore", "pipe", "ignore"],
      cwd: tmpdir(),
    });
    const timer = setTimeout(() => reject(new Error("client never connected")), 5000);
    child.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("CONNECTED")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("error", reject);
  });
}

describe("freePort (in-process)", () => {
  // Exercises the guard pipeline (alive-probe, describe, ghost-filter, plan,
  // SIGTERM wait) inside this process — the subprocess tests above can't
  // give coverage on these paths. Only the happy path runs here; the refusal
  // path calls process.exit and stays subprocess-only.
  it("frees a port held by this app's own process, without exiting", async () => {
    const port = await getFreePort();
    const decoy = await spawnDecoy(port); // ours: cwd = repo root
    const logs: string[] = [];
    try {
      const { freePort } = await import("./dev.mjs");
      await freePort(port, (m: string) => logs.push(m), {
        appDir: process.cwd(),
        takePort: false,
      });
      expect(logs.join("\n")).toMatch(/Freed port/i);
      expect(await portOwners(port)).toEqual([]);
    } finally {
      decoy.kill("SIGKILL");
    }
  }, 15000);

  it("is a no-op on an already-free port", async () => {
    const port = await getFreePort();
    const logs: string[] = [];
    const { freePort } = await import("./dev.mjs");
    await freePort(port, (m: string) => logs.push(m), { appDir: process.cwd() });
    expect(logs.join("\n")).toMatch(/already free/i);
  });
});

describe("dev.mjs frees a port that has attached clients", () => {
  // Regression guard for the lsof over-match: `lsof -ti tcp:PORT` without
  // -sTCP:LISTEN also returns CLIENTS connected to the port (e.g. a browser),
  // which the guard would then refuse as foreign — breaking every restart
  // with a tab open. Only the LISTENER may count as the port's holder.
  it("kills our stale listener even while a foreign-cwd client is connected", async () => {
    const port = await getFreePort();
    const decoy = await spawnDecoy(port); // ours: cwd = repo root
    const client = await spawnClient(port); // foreign cwd, ESTABLISHED
    try {
      const res = runDev(["--kill-only", "--no-open", "--port", String(port)]);
      expect(res.status).toBe(0);
      expect(await portOwners(port)).toEqual([]);
    } finally {
      decoy.kill("SIGKILL");
      client.kill("SIGKILL");
    }
  }, 15000);
});

describe("dev.mjs refuses to kill foreign processes", () => {
  it("a listener from OUTSIDE the app dir survives --kill-only (exit 3)", async () => {
    const port = await getFreePort();
    const decoy = await spawnDecoy(port, tmpdir());
    try {
      const res = runDev(["--kill-only", "--no-open", "--port", String(port)]);
      expect(res.status).toBe(3);
      expect(res.stderr).toMatch(/--take-port/);
      // The foreign process is still alive and still holds the port.
      expect((await portOwners(port)).length).toBeGreaterThan(0);
    } finally {
      decoy.kill("SIGKILL");
    }
  }, 15000);

  it("--take-port kills the foreign listener anyway", async () => {
    const port = await getFreePort();
    const decoy = await spawnDecoy(port, tmpdir());
    try {
      const res = runDev([
        "--kill-only",
        "--no-open",
        "--port",
        String(port),
        "--take-port",
      ]);
      expect(res.status).toBe(0);
      expect(await portOwners(port)).toEqual([]);
    } finally {
      decoy.kill("SIGKILL");
    }
  }, 15000);
});
