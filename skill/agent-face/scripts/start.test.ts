// start.test.ts — headless coverage for the one-command stack launcher.
//
// The full behavior (bridge subprocess + next dev + a browser opening + a
// spoken conversation) needs a human and is UAT. What we verify headlessly is
// the decision logic: argument parsing, the metered-key scrub for the bridge
// child env, and the .env.local wiring transform (append ONLY what is missing,
// never touch existing values) — plus the CLI contract (--help, bad args).

import { describe, it, expect } from "vitest";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import net from "node:net";
import {
  buildBridgeEnv,
  ensureEnvLocalLines,
  parseStartArgs,
  provisionSettingsPassword,
} from "./start.mjs";

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

describe("deterministic settings-password provisioning", () => {
  // The install path agents actually hit: headless, no TTY, no flags. The
  // password must be auto-generated, hashed into .env.local, and the plaintext
  // printed EXACTLY once for the installing agent to capture and relay.
  const fresh = () => mkdtempSync(join(tmpdir(), "start-provision-"));
  const FIXED = "aabbccddeeff00112233";

  it("auto-generates, writes the hash atomically, and prints the plaintext exactly once", () => {
    const dir = fresh();
    const envPath = join(dir, ".env.local");
    const lines: string[] = [];
    const out = provisionSettingsPassword({
      envPath,
      password: null,
      passwordPrompt: true,
      generate: () => FIXED,
      log: (s: string) => lines.push(s),
    });
    expect(out).toMatchObject({ provisioned: true, generated: true });
    const env = readFileSync(envPath, "utf8");
    expect(env).toMatch(
      /^FACE_SETTINGS_PASSWORD_HASH=scrypt:\d+:\d+:\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/m,
    );
    const joined = lines.join("\n");
    expect(joined).toContain("AUTO-GENERATED");
    expect(joined.match(new RegExp(FIXED, "g"))).toHaveLength(1);
    expect(joined).toMatch(/only this once/i);
    expect(joined).toContain("settings-password.mjs"); // the rotation pointer
    // Atomic write: same-dir tmp + rename leaves no droppings.
    expect(readdirSync(dir)).toEqual([".env.local"]);
  });

  it("an existing hash is never touched and nothing is printed", () => {
    const dir = fresh();
    const envPath = join(dir, ".env.local");
    const original = "FACE_SETTINGS_PASSWORD_HASH=scrypt:1:1:1:a:b\nOTHER=1\n";
    writeFileSync(envPath, original);
    const lines: string[] = [];
    const out = provisionSettingsPassword({
      envPath,
      password: null,
      passwordPrompt: true,
      generate: () => FIXED,
      log: (s: string) => lines.push(s),
    });
    expect(out.provisioned).toBe(false);
    expect(readFileSync(envPath, "utf8")).toBe(original);
    expect(lines).toHaveLength(0);
  });

  it("--password wins: no generation, the plaintext is never echoed", () => {
    const dir = fresh();
    const envPath = join(dir, ".env.local");
    const lines: string[] = [];
    let generated = 0;
    const out = provisionSettingsPassword({
      envPath,
      password: "my explicit pass 123",
      passwordPrompt: true,
      generate: () => {
        generated += 1;
        return FIXED;
      },
      log: (s: string) => lines.push(s),
    });
    expect(out).toMatchObject({ provisioned: true, generated: false });
    expect(generated).toBe(0);
    const joined = lines.join("\n");
    expect(joined).not.toContain("my explicit pass 123");
    expect(joined).toContain("password set");
    expect(readFileSync(envPath, "utf8")).toContain("FACE_SETTINGS_PASSWORD_HASH=scrypt:");
  });

  it("--no-password-prompt skips: nothing written, honest skip message", () => {
    const dir = fresh();
    const envPath = join(dir, ".env.local");
    const lines: string[] = [];
    const out = provisionSettingsPassword({
      envPath,
      password: null,
      passwordPrompt: false,
      generate: () => FIXED,
      log: (s: string) => lines.push(s),
    });
    expect(out.provisioned).toBe(false);
    expect(existsSync(envPath)).toBe(false);
    expect(lines.join("\n")).toMatch(/no password set/);
  });

  it("a second run is a no-op (idempotent — the lock is never replaced from here)", () => {
    const dir = fresh();
    const envPath = join(dir, ".env.local");
    provisionSettingsPassword({
      envPath,
      password: null,
      passwordPrompt: true,
      generate: () => FIXED,
      log: () => {},
    });
    const first = readFileSync(envPath, "utf8");
    const lines: string[] = [];
    const again = provisionSettingsPassword({
      envPath,
      password: null,
      passwordPrompt: true,
      generate: () => "ffeeddccbbaa99887766",
      log: (s: string) => lines.push(s),
    });
    expect(again.provisioned).toBe(false);
    expect(readFileSync(envPath, "utf8")).toBe(first);
    expect(lines).toHaveLength(0);
  });

  it("e2e: a headless (non-TTY) first run provisions and prints the one-time password", async () => {
    // Mirror the bridge-port-refusal rig: provisioning happens BEFORE the port
    // check, so the run provisions, then exits 3 on the busy port — bounded,
    // no app boot, real launcher, real stdout.
    const appDir = mkdtempSync(join(tmpdir(), "start-provision-e2e-"));
    mkdirSync(join(appDir, "bridge", "src"), { recursive: true });
    mkdirSync(join(appDir, "bridge", "node_modules"), { recursive: true });
    mkdirSync(join(appDir, "node_modules"), { recursive: true });
    writeFileSync(join(appDir, "bridge", "src", "server.mjs"), "setInterval(()=>{},1e9);\n");
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "x", private: true }));
    const bridgePort = await getFreePort();
    const decoy = await spawnDecoy(bridgePort, tmpdir());
    try {
      const r = runStart([appDir, "--bridge-port", String(bridgePort), "--no-open"]);
      expect(r.status).toBe(3);
      const env = readFileSync(join(appDir, ".env.local"), "utf8");
      expect(env).toMatch(/^FACE_SETTINGS_PASSWORD_HASH=scrypt:/m);
      expect(r.stdout).toContain("AUTO-GENERATED");
      const plaintexts = r.stdout.match(/\b[0-9a-f]{20}\b/g) ?? [];
      expect(plaintexts).toHaveLength(1);
    } finally {
      decoy.kill("SIGKILL");
    }
  }, 20000);
});

describe("settings password provisioning (args + bridge env pass-through)", () => {
  it("parses --password and --no-password-prompt; bare --password is junk", () => {
    expect(parseStartArgs(["--password", "hunter2hunter2"]).password).toBe("hunter2hunter2");
    expect(parseStartArgs(["--no-password-prompt"]).passwordPrompt).toBe(false);
    expect(parseStartArgs([]).passwordPrompt).toBe(true);
    expect(() => parseStartArgs(["--password"])).toThrow(/--password/);
  });

  it("buildBridgeEnv forwards a .env.local CLAUDE_CODE_OAUTH_TOKEN to the bridge child", () => {
    const child = buildBridgeEnv(
      { PATH: "/bin" },
      { yolo: false, fileEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok_from_file" } },
    );
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok_from_file");
  });

  it("the shell env wins over fileEnv for the OAuth token", () => {
    const child = buildBridgeEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: "tok_from_shell" },
      { yolo: false, fileEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok_from_file" } },
    );
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok_from_shell");
  });

  it("the metered-credential scrub is LAST: fileEnv can never smuggle ANTHROPIC_* in", () => {
    const child = buildBridgeEnv(
      { ANTHROPIC_API_KEY: "sk-shell" },
      {
        yolo: false,
        fileEnv: {
          ANTHROPIC_API_KEY: "sk-file",
          ANTHROPIC_AUTH_TOKEN: "tok-file",
          CLAUDE_CODE_OAUTH_TOKEN: "tok_ok",
        },
      },
    );
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok_ok");
  });
});
