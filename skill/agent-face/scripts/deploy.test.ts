// deploy.test.ts — headless coverage for the deploy script.
//
// The full flows (a real `vercel deploy`, a real Docker build) need a live
// Vercel account / Docker daemon and are deferred to UAT. What we CAN verify
// headlessly is the load-bearing CONTRACT:
//   - preflight fails FAST (before any network/build) when app files are missing;
//   - with the Vercel CLI absent, `--target vercel` exits non-zero with the
//     `npm i -g vercel` hint and never starts a partial deploy;
//   - `--target self-host` prints a runnable run command;
//   - the CLI surface (--help, --target validation, unknown args).
// `--dry-run` lets us drive the plan without running install/build/deploy.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  parseArgs,
  preflight,
  providerEnvPresent,
  resolveVercelBin,
  selfHostRunCommand,
  REQUIRED_APP_FILES,
} from "./deploy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOY = join(HERE, "deploy.mjs");
// scripts/ -> agent-face/ -> skill/ -> repo root (a real, deployable app dir).
const REPO_ROOT = join(HERE, "..", "..", "..");

function runDeploy(args: string[], env: Record<string, string> = {}, cwd = REPO_ROOT) {
  return spawnSync("node", [DEPLOY, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, ...env },
  });
}

describe("deploy.mjs CLI contract", () => {
  it("--help prints usage mentioning both targets and exits 0", () => {
    const res = runDeploy(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("deploy.mjs");
    expect(res.stdout).toContain("vercel");
    expect(res.stdout).toContain("self-host");
  });

  it("rejects an unknown option with exit 2", () => {
    const res = runDeploy(["--bogus"]);
    expect(res.status).toBe(2);
  });

  it("rejects an invalid --target with exit 2", () => {
    const res = runDeploy(["--target", "heroku"]);
    expect(res.status).toBe(2);
  });
});

describe("deploy.mjs parseArgs", () => {
  it("defaults to vercel + prod", () => {
    const o = parseArgs([]);
    expect(o.target).toBe("vercel");
    expect(o.prod).toBe(true);
    expect(o.dryRun).toBe(false);
  });

  it("--preview flips prod off; --target=self-host and --docker parse", () => {
    const o = parseArgs(["--target=self-host", "--preview", "--docker", "--dry-run"]);
    expect(o.target).toBe("self-host");
    expect(o.prod).toBe(false);
    expect(o.docker).toBe(true);
    expect(o.dryRun).toBe(true);
  });
});

describe("deploy.mjs pure helpers", () => {
  it("preflight flags every missing required file", () => {
    const empty = mkdtempSync(join(tmpdir(), "af-deploy-"));
    const { ok, missing } = preflight(empty);
    expect(ok).toBe(false);
    expect(missing).toEqual(REQUIRED_APP_FILES);
  });

  it("preflight passes on the real repo app dir", () => {
    expect(preflight(REPO_ROOT).ok).toBe(true);
  });

  it("providerEnvPresent detects a single provider var and ignores blanks", () => {
    expect(providerEnvPresent({})).toBe(false);
    expect(providerEnvPresent({ ANTHROPIC_API_KEY: "  " })).toBe(false);
    expect(providerEnvPresent({ GROQ_API_KEY: "gsk-x" })).toBe(true);
    expect(providerEnvPresent({ AGENT_BRIDGE_URL: "http://localhost:11434" })).toBe(true);
  });

  it("resolveVercelBin honors a VERCEL_BIN override, else defaults to vercel", () => {
    expect(resolveVercelBin({})).toBe("vercel");
    expect(resolveVercelBin({ VERCEL_BIN: "/opt/vercel" })).toBe("/opt/vercel");
  });

  it("selfHostRunCommand switches between compose and next start", () => {
    expect(selfHostRunCommand({ docker: true })).toContain("docker compose up");
    expect(selfHostRunCommand({ docker: false })).toContain("npm run start");
  });
});

describe("deploy.mjs vercel target", () => {
  it("exits non-zero with the install hint when the Vercel CLI is absent, no partial deploy", () => {
    // Force "CLI absent" deterministically via VERCEL_BIN → a command that
    // cannot exist. Preflight passes (repo root), so failure is the CLI check.
    const res = runDeploy(["--target", "vercel", "--dry-run"], {
      VERCEL_BIN: "vercel-definitely-not-installed-xyz",
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("npm i -g vercel");
    // Must fail at the CLI check — before any build/deploy step ran.
    expect(res.stderr).not.toContain("npm run build");
    expect(res.stderr).not.toContain("vercel deploy");
  });
});

describe("deploy.mjs self-host target", () => {
  it("prints a runnable run command in dry-run (no build executed)", () => {
    const res = runDeploy(["--target", "self-host", "--dry-run"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("Self-host build complete");
    expect(res.stderr).toContain("npm run start");
    expect(res.stderr).toContain("AGENT_BRIDGE_URL");
  });

  it("prints the docker compose command with --docker", () => {
    const res = runDeploy(["--target", "self-host", "--docker", "--dry-run"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("docker compose up");
  });

  it("fails preflight fast (exit 1) when app files are missing, before any build", () => {
    // A dir with a package.json (so it's chosen as the app dir) but WITHOUT the
    // api routes / vercel.json — preflight must reject it before building.
    const dir = mkdtempSync(join(tmpdir(), "af-deploy-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "stub" }));
    const res = runDeploy(["--target", "self-host", "--dry-run"], {}, dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Preflight failed");
    expect(res.stderr).toContain("app/api/chat/route.ts");
    // No build/network step should have run.
    expect(res.stderr).not.toContain("Self-host build complete");
  });
});
