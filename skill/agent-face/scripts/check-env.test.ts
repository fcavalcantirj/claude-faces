// check-env.test.ts — headless coverage for the environment-check script.
//
// Two layers: (1) pure-function unit tests over the availability logic, and
// (2) end-to-end spawns of check-env.mjs with a CLEAN env (only the keys we set)
// to prove the exit code, the check/cross table, and — critically — that no
// secret value is ever leaked to stdout.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  computeReport,
  selectBrain,
  isUsable,
  isPublicHttpsUrl,
  parseDotenv,
  parseArgs,
} from "./check-env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "check-env.mjs");

// Run the script with ONLY the given vars (plus PATH) so the host machine's
// real ANTHROPIC_API_KEY etc. can never bleed into the "no keys" case — and
// from an EMPTY temp cwd, because check-env reads ./.env.local by default and
// the developer's real .env.local (e.g. a configured agent bridge) would
// otherwise flip the "no keys" case to a configured one. Found the day a real
// .env.local first existed on a dev machine.
const EMPTY_DIR = mkdtempSync(join(tmpdir(), "check-env-hermetic-"));
function run(vars: Record<string, string> = {}, args: string[] = []) {
  return spawnSync("node", [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: EMPTY_DIR,
    env: { PATH: process.env.PATH ?? "", ...vars } as unknown as NodeJS.ProcessEnv,
  });
}

describe("check-env pure logic", () => {
  it("reports no chat brain with an empty env", () => {
    const report = computeReport({});
    expect(report.providers.anthropic.available).toBe(false);
    expect(report.providers.openrouter.available).toBe(false);
    expect(report.providers.groq.available).toBe(false);
    expect(report.agentBridge.available).toBe(false);
    expect(selectBrain(report)).toBe(null);
    expect(isUsable(report)).toBe(false);
    // Browser voice paths are always available (no key).
    expect(report.stt.browser).toBe(true);
    expect(report.tts.browser).toBe(true);
  });

  it("honors the documented priority anthropic > openrouter > groq", () => {
    const all = computeReport({
      ANTHROPIC_API_KEY: "a",
      OPENROUTER_API_KEY: "b",
      GROQ_API_KEY: "c",
    });
    expect(selectBrain(all)).toBe("anthropic");
    expect(selectBrain(computeReport({ OPENROUTER_API_KEY: "b", GROQ_API_KEY: "c" }))).toBe(
      "openrouter",
    );
    expect(selectBrain(computeReport({ GROQ_API_KEY: "c" }))).toBe("groq");
  });

  it("surfaces default models and env overrides", () => {
    expect(computeReport({ ANTHROPIC_API_KEY: "a" }).providers.anthropic.defaultModel).toBe(
      "claude-opus-4-8",
    );
    expect(
      computeReport({ ANTHROPIC_API_KEY: "a", ANTHROPIC_DEFAULT_MODEL: "claude-sonnet-5" })
        .providers.anthropic.defaultModel,
    ).toBe("claude-sonnet-5");
  });

  it("GROQ_API_KEY unlocks both the groq brain and hosted STT", () => {
    const r = computeReport({ GROQ_API_KEY: "g" });
    expect(r.providers.groq.available).toBe(true);
    expect(r.stt.groq).toBe(true);
  });

  it("OPENAI_API_KEY unlocks hosted STT + TTS but no chat brain", () => {
    const r = computeReport({ OPENAI_API_KEY: "o" });
    expect(r.stt.openai).toBe(true);
    expect(r.tts.openai).toBe(true);
    expect(selectBrain(r)).toBe(null);
    expect(isUsable(r)).toBe(false);
  });

  it("makes the agent-bridge usable on localhost dev, selecting it when no Mode A key", () => {
    const r = computeReport({
      AGENT_BRIDGE_KIND: "ollama",
      AGENT_BRIDGE_URL: "http://localhost:11434",
    });
    expect(r.agentBridge.available).toBe(true);
    expect(selectBrain(r)).toBe("agent-bridge");
    expect(isUsable(r)).toBe(true);
  });

  it("hides a private agent-bridge URL in production (Vercel) unless allowed", () => {
    const priv = computeReport({
      VERCEL: "1",
      AGENT_BRIDGE_KIND: "ollama",
      AGENT_BRIDGE_URL: "http://localhost:11434",
    });
    expect(priv.agentBridge.configured).toBe(true);
    expect(priv.agentBridge.permitted).toBe(false);
    expect(priv.agentBridge.available).toBe(false);

    const allowed = computeReport({
      VERCEL: "1",
      ALLOW_AGENT_BRIDGE_IN_PROD: "1",
      AGENT_BRIDGE_KIND: "ollama",
      AGENT_BRIDGE_URL: "http://localhost:11434",
    });
    expect(allowed.agentBridge.available).toBe(true);

    const publicUrl = computeReport({
      VERCEL: "1",
      AGENT_BRIDGE_KIND: "openai-compatible",
      AGENT_BRIDGE_URL: "https://agent.example.com",
    });
    expect(publicUrl.agentBridge.available).toBe(true);
  });

  it("treats HERMES_API_BASE_URL as a hermes bridge alias", () => {
    const r = computeReport({ HERMES_API_BASE_URL: "http://localhost:8080" });
    expect(r.agentBridge.kind).toBe("hermes");
    expect(r.agentBridge.available).toBe(true);
  });

  it("classifies public vs private URLs", () => {
    expect(isPublicHttpsUrl("https://agent.example.com")).toBe(true);
    expect(isPublicHttpsUrl("http://agent.example.com")).toBe(false); // not https
    expect(isPublicHttpsUrl("https://localhost:3000")).toBe(false);
    expect(isPublicHttpsUrl("https://127.0.0.1")).toBe(false);
    expect(isPublicHttpsUrl("https://10.0.0.5")).toBe(false);
    expect(isPublicHttpsUrl("https://192.168.1.9")).toBe(false);
    expect(isPublicHttpsUrl("https://host.local")).toBe(false);
  });

  it("parses dotenv lines (export/quotes/comments)", () => {
    const parsed = parseDotenv(
      ["# comment", "ANTHROPIC_API_KEY=abc", 'export GROQ_API_KEY="xyz"', "BLANK="].join("\n"),
    );
    expect(parsed.ANTHROPIC_API_KEY).toBe("abc");
    expect(parsed.GROQ_API_KEY).toBe("xyz");
    expect(parsed.BLANK).toBe("");
  });

  it("parseArgs reads the app-dir positional and flags", () => {
    expect(parseArgs(["./my-face", "--json"])).toMatchObject({
      dir: "./my-face",
      json: true,
    });
  });
});

describe("check-env.mjs CLI", () => {
  it("--help prints usage and exits 0", () => {
    const res = run({}, ["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("check-env.mjs");
    expect(res.stdout.toLowerCase()).toContain("priority");
  });

  it("rejects an unknown option with a non-zero exit", () => {
    const res = run({}, ["--bogus"]);
    expect(res.status).toBe(2);
  });

  // Verify (task): with no keys set, prints all crosses, a 'no brain configured'
  // hint, and exits non-zero.
  it("with no keys: all crosses, a 'no brain configured' hint, non-zero exit", () => {
    const res = run({});
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain("✗");
    expect(res.stdout).not.toContain("Selected brain: Anthropic");
    const lower = res.stdout.toLowerCase();
    expect(lower).toContain("no chat brain configured");
  });

  // Verify (task): with ANTHROPIC_API_KEY set, prints Anthropic available, names
  // it the selected brain, exits 0 WITHOUT leaking the value.
  it("with ANTHROPIC_API_KEY: Anthropic selected, exit 0, no secret leak", () => {
    const secret = "sk-ant-SECRET-do-not-leak-1234567890";
    const res = run({ ANTHROPIC_API_KEY: secret });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Anthropic");
    expect(res.stdout).toContain("Selected brain: Anthropic");
    expect(res.stdout).not.toContain(secret);
    expect(res.stdout).not.toContain("sk-ant-");
  });

  // The bridge has no per-request model, and the summary used to interpolate
  // that absence as a literal "(null)". It must show the kind instead.
  it("agent-bridge selected: summary shows the kind, never (null)", () => {
    const res = run({
      AGENT_BRIDGE_KIND: "claude-code",
      AGENT_BRIDGE_URL: "http://127.0.0.1:8787",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Selected brain: Agent bridge (kind: claude-code)");
    expect(res.stdout).not.toContain("(null)");
  });

  it("--json emits a secret-free machine-readable report", () => {
    const secret = "gsk-SECRET-do-not-leak";
    const res = run({ GROQ_API_KEY: secret }, ["--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.selectedBrain).toBe("groq");
    expect(parsed.stt.groq).toBe(true);
    expect(parsed.usable).toBe(true);
    expect(res.stdout).not.toContain(secret);
    expect(res.stdout).not.toContain("gsk-");
  });
});
