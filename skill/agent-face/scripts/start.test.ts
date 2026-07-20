// start.test.ts — headless coverage for the one-command stack launcher.
//
// The full behavior (bridge subprocess + next dev + a browser opening + a
// spoken conversation) needs a human and is UAT. What we verify headlessly is
// the decision logic: argument parsing, the metered-key scrub for the bridge
// child env, and the .env.local wiring transform (append ONLY what is missing,
// never touch existing values) — plus the CLI contract (--help, bad args).

import { describe, it, expect } from "vitest";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import net from "node:net";
import { buildBridgeEnv, ensureEnvLocalLines, parseStartArgs } from "./start.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const START = join(HERE, "start.mjs");

function runStart(args: string[]) {
  return spawnSync("node", [START, ...args], { encoding: "utf8", timeout: 20000 });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

// A listener in a separate process; cwd decides ours (repo root) vs foreign.
function spawnDecoy(port: number, cwd?: string): Promise<ChildProcess> {
  const code =
    `const net=require('net');` +
    `net.createServer().listen(${port},'127.0.0.1',()=>process.stdout.write('READY'));` +
    `setInterval(()=>{},1e9);`;
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["-e", code], { stdio: ["ignore", "pipe", "ignore"], cwd });
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

describe("parseStartArgs", () => {
  it("defaults: port 3000, bridge port 8787, bridge auto, open browser", () => {
    const a = parseStartArgs([]);
    expect(a).toMatchObject({
      port: 3000,
      bridgePort: 8787,
      bridge: true,
      yolo: false,
      open: true,
      stop: false,
      help: false,
    });
  });

  it("parses the full flag set", () => {
    const a = parseStartArgs([
      "--port", "3100", "--bridge-port", "9000", "--yolo", "--no-bridge", "--no-open", "--stop",
    ]);
    expect(a).toMatchObject({
      port: 3100,
      bridgePort: 9000,
      bridge: false,
      yolo: true,
      open: false,
      stop: true,
    });
  });

  it("rejects unknown flags and junk ports", () => {
    expect(() => parseStartArgs(["--bogus"])).toThrow(/unknown/i);
    expect(() => parseStartArgs(["--port", "banana"])).toThrow(/port/i);
  });

  it("parses --take-port (default off)", () => {
    expect(parseStartArgs([]).takePort).toBe(false);
    expect(parseStartArgs(["--take-port"]).takePort).toBe(true);
  });
});

describe("buildBridgeEnv", () => {
  it("SCRUBS metered credentials so the bridge guard never trips", () => {
    const env = buildBridgeEnv(
      { PATH: "/bin", ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_AUTH_TOKEN: "t", HOME: "/h" },
      { yolo: false },
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/h");
    expect(env.CLAUDE_BRIDGE_PERMISSION_MODE).toBeUndefined();
  });

  it("--yolo sets bypassPermissions on the child only", () => {
    const env = buildBridgeEnv({ PATH: "/bin" }, { yolo: true });
    expect(env.CLAUDE_BRIDGE_PERMISSION_MODE).toBe("bypassPermissions");
  });
});

describe("ensureEnvLocalLines", () => {
  it("appends BOTH bridge lines to an empty file and reports them", () => {
    const r = ensureEnvLocalLines("", 8787);
    expect(r.added).toEqual(["AGENT_BRIDGE_KIND=claude-code", "AGENT_BRIDGE_URL=http://127.0.0.1:8787"]);
    expect(r.content).toContain("AGENT_BRIDGE_KIND=claude-code");
    expect(r.content).toContain("AGENT_BRIDGE_URL=http://127.0.0.1:8787");
  });

  it("NEVER touches an existing value (a hermes user stays a hermes user)", () => {
    const existing = "AGENT_BRIDGE_KIND=hermes\nAGENT_BRIDGE_URL=http://10.0.0.5:9099\n";
    const r = ensureEnvLocalLines(existing, 8787);
    expect(r.added).toEqual([]);
    expect(r.content).toBe(existing);
  });

  it("appends only what is missing", () => {
    const r = ensureEnvLocalLines("AGENT_BRIDGE_KIND=claude-code\n", 8787);
    expect(r.added).toEqual(["AGENT_BRIDGE_URL=http://127.0.0.1:8787"]);
    expect(r.content).toContain("AGENT_BRIDGE_KIND=claude-code");
  });

  it("a commented-out line does not count as configured", () => {
    const r = ensureEnvLocalLines("# AGENT_BRIDGE_KIND=hermes\n", 8787);
    expect(r.added).toContain("AGENT_BRIDGE_KIND=claude-code");
  });
});

describe("start.mjs --stop (e2e)", () => {
  it("refuses a foreign holder with exit 3 and leaves it alive", async () => {
    const appPort = await getFreePort();
    const bridgePort = await getFreePort();
    const decoy = await spawnDecoy(appPort, tmpdir()); // foreign cwd
    try {
      const r = runStart(["--stop", "--port", String(appPort), "--bridge-port", String(bridgePort)]);
      expect(r.status).toBe(3);
      expect(r.stderr + r.stdout).toMatch(/--take-port/);
      expect(decoy.exitCode).toBeNull(); // still running
    } finally {
      decoy.kill("SIGKILL");
    }
  }, 20000);

  it("kills this app's own holder and exits 0", async () => {
    const appPort = await getFreePort();
    const bridgePort = await getFreePort();
    const decoy = await spawnDecoy(appPort); // ours: cwd = repo root
    try {
      const r = runStart(["--stop", "--port", String(appPort), "--bridge-port", String(bridgePort)]);
      expect(r.status).toBe(0);
    } finally {
      decoy.kill("SIGKILL");
    }
  }, 20000);

  it("--stop --take-port kills a foreign holder too (flag forwarded to dev.mjs)", async () => {
    const appPort = await getFreePort();
    const bridgePort = await getFreePort();
    const decoy = await spawnDecoy(appPort, tmpdir());
    try {
      const r = runStart([
        "--stop", "--take-port",
        "--port", String(appPort),
        "--bridge-port", String(bridgePort),
      ]);
      expect(r.status).toBe(0);
    } finally {
      decoy.kill("SIGKILL");
    }
  }, 20000);
});

describe("start.mjs bridge-port refusal (e2e)", () => {
  it("aborts with exit 3 before starting anything when a foreign process holds the bridge port", async () => {
    // A minimal app dir with a bridge/ so the bridge path engages, and
    // node_modules present so no npm install runs.
    const appDir = mkdtempSync(join(tmpdir(), "start-bridge-refusal-"));
    mkdirSync(join(appDir, "bridge", "src"), { recursive: true });
    mkdirSync(join(appDir, "bridge", "node_modules"), { recursive: true });
    mkdirSync(join(appDir, "node_modules"), { recursive: true });
    writeFileSync(join(appDir, "bridge", "src", "server.mjs"), "setInterval(()=>{},1e9);\n");
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "x", private: true }));

    const bridgePort = await getFreePort();
    const decoy = await spawnDecoy(bridgePort, tmpdir()); // foreign to appDir
    try {
      const r = runStart([appDir, "--bridge-port", String(bridgePort), "--no-open"]);
      expect(r.status).toBe(3);
      expect(r.stderr + r.stdout).toMatch(/--bridge-port|--take-port/);
      expect(decoy.exitCode).toBeNull();
    } finally {
      decoy.kill("SIGKILL");
    }
  }, 20000);
});

describe("start.mjs CLI contract", () => {
  it("--help exits 0 and documents the one-command behavior", () => {
    const r = runStart(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/bridge/i);
    expect(r.stdout).toMatch(/--stop/);
    expect(r.stdout).toMatch(/--yolo/);
    expect(r.stdout).toMatch(/--take-port/);
  });

  it("an unknown flag exits non-zero with the usage", () => {
    const r = runStart(["--nonsense"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/unknown/i);
  });
});
