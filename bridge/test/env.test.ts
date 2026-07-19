// @vitest-environment node
//
// The fail-closed subscription guard. Ported from hermes-agent, which refuses
// to start when a metered key is present because the Claude Code CLI silently
// PREFERS the key over the subscription login — flipping billing from
// "included in the plan" to pay-per-token without any visible signal. Felipe's
// shell exports provider keys, so without this guard the bridge would silently
// bill every conversation.

import { describe, it, expect } from "vitest";
import { assertSubscriptionAuth, loadEnv } from "../src/env.mjs";

describe("assertSubscriptionAuth (fail closed)", () => {
  it("refuses to start when ANTHROPIC_API_KEY is set", () => {
    expect(() => assertSubscriptionAuth({ ANTHROPIC_API_KEY: "sk-ant-x" })).toThrow(
      /ANTHROPIC_API_KEY.*metered/s,
    );
  });

  it("refuses to start when ANTHROPIC_AUTH_TOKEN is set", () => {
    expect(() => assertSubscriptionAuth({ ANTHROPIC_AUTH_TOKEN: "tok" })).toThrow(
      /ANTHROPIC_AUTH_TOKEN.*metered/s,
    );
  });

  it("names the escape hatch in the refusal message", () => {
    expect(() => assertSubscriptionAuth({ ANTHROPIC_API_KEY: "sk-ant-x" })).toThrow(
      /CLAUDE_BRIDGE_ALLOW_API_KEY/,
    );
  });

  it("allows startup with the explicit escape hatch", () => {
    expect(() =>
      assertSubscriptionAuth({ ANTHROPIC_API_KEY: "sk-ant-x", CLAUDE_BRIDGE_ALLOW_API_KEY: "1" }),
    ).not.toThrow();
  });

  it("passes when no metered credential is present", () => {
    expect(() => assertSubscriptionAuth({ PATH: "/usr/bin" })).not.toThrow();
  });

  it("an empty string does not trip the guard", () => {
    expect(() => assertSubscriptionAuth({ ANTHROPIC_API_KEY: "" })).not.toThrow();
  });
});

describe("loadEnv", () => {
  it("applies defaults", () => {
    const e = loadEnv({});
    expect(e.port).toBe(8787);
    expect(e.host).toBe("127.0.0.1");
    expect(e.token).toBeNull();
    expect(e.model).toBeNull();
    expect(e.permissionMode).toBe("acceptEdits");
    expect(e.allowMeteredKey).toBe(false);
  });

  it("reads overrides", () => {
    const e = loadEnv({
      CLAUDE_BRIDGE_PORT: "9000",
      CLAUDE_BRIDGE_HOST: "0.0.0.0",
      CLAUDE_BRIDGE_TOKEN: "secret",
      CLAUDE_BRIDGE_MODEL: "claude-sonnet-5",
      CLAUDE_BRIDGE_PERMISSION_MODE: "default",
      CLAUDE_BRIDGE_CWD: "/tmp/x",
      CLAUDE_BRIDGE_ALLOW_API_KEY: "true",
    });
    expect(e.port).toBe(9000);
    expect(e.host).toBe("0.0.0.0");
    expect(e.token).toBe("secret");
    expect(e.model).toBe("claude-sonnet-5");
    expect(e.permissionMode).toBe("default");
    expect(e.cwd).toBe("/tmp/x");
    expect(e.allowMeteredKey).toBe(true);
  });

  it("rejects a nonsense port", () => {
    expect(() => loadEnv({ CLAUDE_BRIDGE_PORT: "banana" })).toThrow(/CLAUDE_BRIDGE_PORT/);
  });
});
