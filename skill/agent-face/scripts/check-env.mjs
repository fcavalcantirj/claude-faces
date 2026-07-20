#!/usr/bin/env node
// check-env.mjs — report which brains / STT / TTS are configured for Agent Face.
//
// A host agent (or a human) runs this BEFORE dev/deploy to see what the app can
// actually do with the current environment: which chat brain would answer,
// whether voice-in/voice-out have hosted upgrades, and — crucially — whether
// anything is wired at all. It reads the process environment plus, optionally, a
// `.env.local` in the target app dir (Next.js precedence: shell env > .env.local
// > .env), and prints a check/cross table + a resolved summary.
//
//   node skill/agent-face/scripts/check-env.mjs             # check ./ (+ ./.env.local)
//   node skill/agent-face/scripts/check-env.mjs ./my-face   # check a scaffolded app dir
//   node skill/agent-face/scripts/check-env.mjs --json       # machine-readable, no secrets
//   node skill/agent-face/scripts/check-env.mjs --probe      # live-probe the agent-bridge URL
//   node skill/agent-face/scripts/check-env.mjs --help
//
// SECURITY: this NEVER prints a secret value — only presence/absence (✓/✗).
// Every provider key is masked; only non-secret model ids / labels are shown.
//
// EXIT CODE: 0 when at least one chat brain is usable, non-zero (with guidance)
// otherwise — so `check-env && dev` / CI gates read cleanly.
//
// No external deps, no harness-specific tooling — plain Node ESM + node:fs so
// any harness on any OS can run it. Availability logic mirrors lib/providers/*
// and docs/env-contract.md (kept consistent by hand; this script must not import
// the TypeScript app modules so it stays runnable when extracted standalone).

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Which env vars unlock what. The single source of truth is docs/env-contract.md.
// ---------------------------------------------------------------------------

const CHAT_PRIORITY = ["anthropic", "openrouter", "groq", "agent-bridge"];

const DEFAULTS = {
  anthropic: "claude-opus-4-8",
  openrouter: "nousresearch/hermes-3-llama-3.1-70b",
  groq: "llama-3.3-70b-versatile",
};

const VALID_BRIDGE_KINDS = [
  "hermes",
  "openclaw",
  "claude-code",
  "ollama",
  "openai-compatible",
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function present(v) {
  return typeof v === "string" && v.trim() !== "";
}

function truthy(v) {
  const s = (v ?? "").toString().trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function firstNonEmpty(...vals) {
  for (const v of vals) if (present(v)) return v.trim();
  return undefined;
}

// Minimal, dependency-free .env parser (KEY=VALUE, `export ` prefix + quotes
// tolerated). Used ONLY to read presence for the report — values never printed.
/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotenv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// Merge, honoring Next.js precedence: real shell env > .env.local > .env.
// Returns { env, sources } where sources lists the files that contributed.
export function loadEnv({ dir = ".", processEnv = process.env } = {}) {
  const base = resolve(dir);
  const sources = ["process environment"];
  let fileEnv = {};
  for (const name of [".env", ".env.local"]) {
    const p = join(base, name);
    if (existsSync(p)) {
      try {
        fileEnv = { ...fileEnv, ...parseDotenv(readFileSync(p, "utf8")) };
        sources.push(join(dir, name));
      } catch {
        // Unreadable env file: skip it rather than crash the report.
      }
    }
  }
  const env = { ...fileEnv };
  // Shell env wins, but only for keys that are actually defined there.
  for (const [k, v] of Object.entries(processEnv)) {
    if (v !== undefined) env[k] = v;
  }
  return { env, sources };
}

export function isPublicHttpsUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return false;
  if (host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return false;
  // RFC-1918 private ranges.
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Pure availability computation — env in, structured report out. No I/O.
// ---------------------------------------------------------------------------

export function computeReport(env = {}) {
  const providers = {
    anthropic: {
      available: present(env.ANTHROPIC_API_KEY),
      keyVar: "ANTHROPIC_API_KEY",
      defaultModel: firstNonEmpty(env.ANTHROPIC_DEFAULT_MODEL) ?? DEFAULTS.anthropic,
    },
    openrouter: {
      available: present(env.OPENROUTER_API_KEY),
      keyVar: "OPENROUTER_API_KEY",
      defaultModel: firstNonEmpty(env.OPENROUTER_DEFAULT_MODEL) ?? DEFAULTS.openrouter,
    },
    groq: {
      available: present(env.GROQ_API_KEY),
      keyVar: "GROQ_API_KEY",
      defaultModel: firstNonEmpty(env.GROQ_DEFAULT_MODEL) ?? DEFAULTS.groq,
    },
  };

  const agentBridge = computeAgentBridge(env);

  const stt = {
    browser: true, // in-browser Whisper (WebGPU/WASM) — always, no key, offline
    groq: present(env.GROQ_API_KEY),
    openai: present(env.OPENAI_API_KEY),
  };
  const tts = {
    browser: true, // Web Speech API — always, no key
    openai: present(env.OPENAI_API_KEY),
  };

  return { providers, agentBridge, stt, tts };
}

function computeAgentBridge(env) {
  let kind = (env.AGENT_BRIDGE_KIND ?? "").trim().toLowerCase();
  if (!kind && present(env.HERMES_API_BASE_URL)) kind = "hermes";

  let url = firstNonEmpty(env.AGENT_BRIDGE_URL, env.HERMES_API_BASE_URL);
  if (!url && kind === "ollama") url = "http://localhost:11434";

  const validKind = VALID_BRIDGE_KINDS.includes(kind);
  const configured = validKind && Boolean(url);

  const selfHost = truthy(env.SELF_HOST);
  const onVercel = present(env.VERCEL) || present(env.VERCEL_ENV);

  let permitted = false;
  let reason;
  if (!configured) {
    reason = validKind
      ? "no AGENT_BRIDGE_URL / HERMES_API_BASE_URL set"
      : "no AGENT_BRIDGE_KIND set (hermes|openclaw|claude-code|ollama|openai-compatible)";
  } else if (selfHost) {
    permitted = true;
  } else if (onVercel) {
    if (truthy(env.ALLOW_AGENT_BRIDGE_IN_PROD) || isPublicHttpsUrl(url)) {
      permitted = true;
    } else {
      reason =
        "private URL not exposed on Vercel — set ALLOW_AGENT_BRIDGE_IN_PROD=1 or use a public HTTPS URL";
    }
  } else {
    permitted = true; // localhost dev reaches a private agent directly
  }

  return {
    kind: kind || null,
    configured,
    permitted,
    available: configured && permitted,
    defaultModel: firstNonEmpty(env.AGENT_BRIDGE_MODEL) ?? null,
    reason: permitted ? undefined : reason,
    // `reachable` stays undefined unless --probe actually tests the endpoint.
    reachable: undefined,
  };
}

export function selectBrain(report) {
  for (const id of CHAT_PRIORITY) {
    if (id === "agent-bridge") {
      if (report.agentBridge.available) return "agent-bridge";
    } else if (report.providers[id]?.available) {
      return id;
    }
  }
  return null;
}

const BRAIN_LABEL = {
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  groq: "Groq",
  "agent-bridge": "Agent bridge",
};

export function selectedModel(report, brain) {
  if (!brain) return null;
  if (brain === "agent-bridge") return report.agentBridge.defaultModel;
  return report.providers[brain]?.defaultModel ?? null;
}

// A chat path exists if any Mode A brain is keyed OR the agent-bridge is usable.
// With --probe, an agent-bridge that fails the live probe no longer counts.
export function isUsable(report) {
  const anyProvider = Object.values(report.providers).some((p) => p.available);
  const bridge =
    report.agentBridge.available &&
    report.agentBridge.reachable !== false; // undefined (unprobed) still counts
  return anyProvider || bridge;
}

// ---------------------------------------------------------------------------
// Optional live reachability probe (only with --probe; global fetch, Node 18+).
// ---------------------------------------------------------------------------

async function probeAgentBridge(report, env) {
  if (!report.agentBridge.configured) return;
  const url = firstNonEmpty(env.AGENT_BRIDGE_URL, env.HERMES_API_BASE_URL) ??
    (report.agentBridge.kind === "ollama" ? "http://localhost:11434" : null);
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    // A plain GET to the base URL: any HTTP response (even 404) proves the
    // socket is live. Only a network-level failure means "offline".
    await fetch(url, { method: "GET", signal: controller.signal });
    report.agentBridge.reachable = true;
  } catch {
    report.agentBridge.reachable = false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const OK = "✓";
const NO = "✗";

function mark(on) {
  return on ? OK : NO;
}

function formatText(report, { sources }) {
  const brain = selectBrain(report);
  const lines = [];
  lines.push("Agent Face — environment check");
  lines.push(`  sources: ${sources.join(" + ")}`);
  lines.push("");

  lines.push("Chat brains (Mode A — hosted API):");
  for (const id of ["anthropic", "openrouter", "groq"]) {
    const p = report.providers[id];
    const tail = p.available ? `available  (model: ${p.defaultModel})` : "not set";
    lines.push(`  ${mark(p.available)} ${BRAIN_LABEL[id].padEnd(11)} ${p.keyVar.padEnd(20)} ${tail}`);
  }
  lines.push("");

  lines.push("Agent bridge (Mode B — your running agent):");
  const ab = report.agentBridge;
  let abTail;
  if (ab.available) {
    abTail = `available  (kind: ${ab.kind}${
      ab.reachable === true ? ", reachable" : ""
    }${ab.reachable === false ? ", OFFLINE" : ""})`;
  } else if (ab.configured && !ab.permitted) {
    abTail = `configured but not exposed — ${ab.reason}`;
  } else {
    abTail = `not configured — ${ab.reason}`;
  }
  const abOn = ab.available && ab.reachable !== false;
  lines.push(`  ${mark(abOn)} ${"agent-bridge".padEnd(11)} ${"AGENT_BRIDGE_*".padEnd(20)} ${abTail}`);
  lines.push("");

  lines.push("Speech-to-text (voice in):");
  lines.push(`  ${OK} ${"browser".padEnd(11)} ${"(no key)".padEnd(20)} in-browser Whisper (WebGPU/WASM), offline`);
  lines.push(`  ${mark(report.stt.groq)} ${"groq".padEnd(11)} ${"GROQ_API_KEY".padEnd(20)} ${report.stt.groq ? "hosted whisper-large-v3-turbo" : "not set"}`);
  lines.push(`  ${mark(report.stt.openai)} ${"openai".padEnd(11)} ${"OPENAI_API_KEY".padEnd(20)} ${report.stt.openai ? "hosted gpt-4o-transcribe" : "not set"}`);
  lines.push("");

  lines.push("Text-to-speech (voice out):");
  lines.push(`  ${OK} ${"browser".padEnd(11)} ${"(no key)".padEnd(20)} Web Speech API`);
  lines.push(`  ${mark(report.tts.openai)} ${"openai".padEnd(11)} ${"OPENAI_API_KEY".padEnd(20)} ${report.tts.openai ? "gpt-4o-mini-tts (FFT lip-sync)" : "not set"}`);
  lines.push("");

  lines.push("Summary:");
  if (brain) {
    // The bridge usually has no per-request model (the running agent decides);
    // show its kind rather than interpolating null into the summary.
    const model = selectedModel(report, brain);
    const detail =
      model ?? (brain === "agent-bridge" ? `kind: ${report.agentBridge.kind}` : null);
    lines.push(`  Selected brain: ${BRAIN_LABEL[brain]}${detail ? ` (${detail})` : ""}`);
  } else {
    lines.push("  Selected brain: — none —");
  }
  lines.push("  Priority:       anthropic > openrouter > groq > agent-bridge");
  const hostedStt = report.stt.groq || report.stt.openai;
  lines.push(
    `  Voice input:    ${OK} works (browser Whisper${hostedStt ? " + hosted STT" : ", no hosted key"})`,
  );
  lines.push(
    `  Voice output:   ${report.tts.openai ? "OpenAI gpt-4o-mini-tts (FFT lip-sync)" : "browser Web Speech (add OPENAI_API_KEY for FFT lip-sync)"}`,
  );
  lines.push("");

  if (isUsable(report)) {
    lines.push(`${OK} Ready: at least one chat brain is usable.`);
  } else {
    lines.push(
      `${NO} No chat brain configured. Set ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or`,
    );
    lines.push(
      "  GROQ_API_KEY, or wire a running agent via AGENT_BRIDGE_KIND + AGENT_BRIDGE_URL.",
    );
    lines.push("  See .env.example and docs/env-contract.md. Voice + face still work locally.");
  }

  return lines.join("\n");
}

function toJson(report) {
  const brain = selectBrain(report);
  return {
    providers: Object.fromEntries(
      Object.entries(report.providers).map(([id, p]) => [
        id,
        { available: p.available, defaultModel: p.available ? p.defaultModel : null },
      ]),
    ),
    agentBridge: {
      available: report.agentBridge.available,
      configured: report.agentBridge.configured,
      permitted: report.agentBridge.permitted,
      kind: report.agentBridge.kind,
      reachable: report.agentBridge.reachable ?? null,
      reason: report.agentBridge.reason ?? null,
    },
    stt: report.stt,
    tts: report.tts,
    selectedBrain: brain,
    selectedModel: selectedModel(report, brain),
    voiceInput: true, // browser Whisper always available
    usable: isUsable(report),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function help() {
  console.log(
    `check-env.mjs — report which brains / STT / TTS are configured (no secrets printed).

Usage:
  node check-env.mjs [app-dir] [options]

Arguments:
  app-dir           Directory to read .env / .env.local from (default: current dir).

Options:
  --json            Emit a machine-readable JSON report (still no secret values).
  --probe           Live-probe the agent-bridge URL to confirm reachability.
  --help, -h        Show this help.

Exit code:
  0  at least one chat brain is usable.
  1  no chat brain configured (guidance is printed).

Every provider key is read SERVER-SIDE and reported as present/absent only — the
value is never displayed. Chat-brain priority: anthropic > openrouter > groq >
agent-bridge. With zero keys the app still runs on in-browser Whisper + Web Speech.`,
  );
}

export function parseArgs(argv) {
  const opts = { dir: ".", json: false, probe: false, help: false };
  let sawDir = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--probe") opts.probe = true;
    else if (arg.startsWith("-")) {
      console.error(`✗ Unknown option: ${arg}\n`);
      help();
      process.exit(2);
    } else if (!sawDir) {
      opts.dir = arg;
      sawDir = true;
    } else {
      console.error(`✗ Unexpected extra argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }

  const { env, sources } = loadEnv({ dir: opts.dir });
  const report = computeReport(env);

  if (opts.probe) {
    await probeAgentBridge(report, env);
  }

  if (opts.json) {
    console.log(JSON.stringify(toJson(report), null, 2));
  } else {
    console.log(formatText(report, { sources }));
  }

  process.exit(isUsable(report) ? 0 : 1);
}

// Only run the CLI when executed directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
