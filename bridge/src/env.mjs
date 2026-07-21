// Environment contract for the bridge. Two jobs:
//
//   1. loadEnv() — parse the CLAUDE_BRIDGE_* knobs with safe defaults
//      (127.0.0.1, port 8787, acceptEdits).
//   2. assertSubscriptionAuth() — the FAIL-CLOSED guard ported from
//      hermes-agent: refuse to start while ANTHROPIC_API_KEY or
//      ANTHROPIC_AUTH_TOKEN is exported, because the Claude Code CLI silently
//      PREFERS a key over the subscription login, flipping billing from
//      "included in the plan" to metered API usage with no visible signal.
//      The bridge resolves no credentials itself; the SDK subprocess
//      self-authenticates via CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`)
//      or the ~/.claude credential store.

const METERED_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

function isTruthy(value) {
  return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/**
 * Refuse to run on metered credentials unless explicitly allowed.
 * @param {Record<string, string | undefined>} [env]
 */
export function assertSubscriptionAuth(env = process.env) {
  if (isTruthy(env.CLAUDE_BRIDGE_ALLOW_API_KEY)) return;
  for (const name of METERED_VARS) {
    if (env[name]) {
      throw new Error(
        `claude-agent-bridge refuses to start: ${name} is set, and the Claude Code CLI ` +
          `silently prefers it over your subscription login — every conversation would be ` +
          `billed as metered API usage instead of using the plan you already pay for. ` +
          `Unset it for this process, or set CLAUDE_BRIDGE_ALLOW_API_KEY=1 to explicitly ` +
          `accept metered billing.`,
      );
    }
  }
}

/**
 * Parse the CLAUDE_BRIDGE_* env knobs.
 * @param {Record<string, string | undefined>} [env]
 */
export function loadEnv(env = process.env) {
  let port = 8787;
  if (env.CLAUDE_BRIDGE_PORT !== undefined && env.CLAUDE_BRIDGE_PORT !== "") {
    port = Number(env.CLAUDE_BRIDGE_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`CLAUDE_BRIDGE_PORT must be a port number, got "${env.CLAUDE_BRIDGE_PORT}".`);
    }
  }
  return {
    port,
    host: env.CLAUDE_BRIDGE_HOST || "127.0.0.1",
    token: env.CLAUDE_BRIDGE_TOKEN || null,
    model: env.CLAUDE_BRIDGE_MODEL || null,
    permissionMode: env.CLAUDE_BRIDGE_PERMISSION_MODE || "acceptEdits",
    cwd: env.CLAUDE_BRIDGE_CWD || null,
    allowMeteredKey: isTruthy(env.CLAUDE_BRIDGE_ALLOW_API_KEY),
    // The warm-session escape hatch: "0" reverts to one subprocess per turn
    // (today-parity behavior) — an operational rollback and the A/B lever for
    // latency measurement. Anything else (including unset) stays warm.
    warm: env.CLAUDE_BRIDGE_WARM !== "0",
  };
}
