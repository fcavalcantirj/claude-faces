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
function spawnDecoy(port: number): Promise<ChildProcess> {
  const code =
    `const net=require('net');` +
    `net.createServer().listen(${port},'127.0.0.1',()=>process.stdout.write('READY'));` +
    `setInterval(()=>{},1e9);`;
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["-e", code], {
      stdio: ["ignore", "pipe", "ignore"],
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
