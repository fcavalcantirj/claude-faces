// @vitest-environment node
//
// SDK message → bridge event projection. The bridge is TEXT ONLY by design:
// server-side tools (ServerToolUseBlock — web_search, web_fetch) return their
// results inside the SAME assistant message and never as a {role:'tool'} echo,
// so projecting them as OpenAI tool_calls would persist a dangling
// tool_call_id that breaks the client's full-history replay. hermes-agent pins
// this with a dedicated test; this file is that pin, ported.

import { describe, it, expect } from "vitest";
import { projectMessage } from "../src/projector.mjs";

const streamDelta = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "stream_event",
  session_id: "s-1",
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  ...extra,
});

describe("projectMessage", () => {
  it("captures the session id from the init system message", () => {
    const events = projectMessage({ type: "system", subtype: "init", session_id: "s-42" });
    expect(events).toEqual([{ type: "session", sessionId: "s-42" }]);
  });

  it("unwraps text deltas from stream events", () => {
    expect(projectMessage(streamDelta("hel"))).toEqual([{ type: "delta", text: "hel" }]);
  });

  it("DROPS deltas carrying parent_tool_use_id (subagent monologue)", () => {
    expect(projectMessage(streamDelta("secret inner monologue", { parent_tool_use_id: "t-9" }))).toEqual(
      [],
    );
  });

  it("ignores non-text deltas (thinking, input_json)", () => {
    const msg = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } },
    };
    expect(projectMessage(msg)).toEqual([]);
    expect(
      projectMessage({ type: "stream_event", event: { type: "message_start" } }),
    ).toEqual([]);
  });

  it("projects assistant text blocks as fallback text", () => {
    const events = projectMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "found it" }] },
    });
    expect(events).toEqual([{ type: "assistant_text", text: "found it" }]);
  });

  it("PIN: an assistant message with a server tool use emits text only — never tool_calls", () => {
    const events = projectMessage({
      type: "assistant",
      message: {
        content: [
          { type: "server_tool_use", id: "srv-1", name: "web_search", input: { query: "x" } },
          { type: "web_search_tool_result", tool_use_id: "srv-1", content: [] },
          { type: "text", text: "found it" },
        ],
      },
    });
    expect(events).toEqual([{ type: "assistant_text", text: "found it" }]);
    expect(JSON.stringify(events)).not.toContain("tool_calls");
    expect(JSON.stringify(events)).not.toContain("srv-1");
  });

  it("drops assistant messages from subagents (parent_tool_use_id)", () => {
    const events = projectMessage({
      type: "assistant",
      parent_tool_use_id: "t-1",
      message: { content: [{ type: "text", text: "inner" }] },
    });
    expect(events).toEqual([]);
  });

  it("maps a success result to stop + OpenAI usage", () => {
    const events = projectMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "final text",
      session_id: "s-42",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
    });
    expect(events).toEqual([
      { type: "session", sessionId: "s-42" },
      {
        type: "result",
        finishReason: "stop",
        isError: false,
        text: "final text",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]);
  });

  it("maps error_max_turns to length", () => {
    const [, result] = projectMessage({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      session_id: "s-42",
    });
    expect(result).toMatchObject({ type: "result", finishReason: "length", isError: true });
  });

  it("ignores unknown message types", () => {
    expect(projectMessage({ type: "user", message: {} })).toEqual([]);
    expect(projectMessage({ type: "system", subtype: "compact_boundary" })).toEqual([]);
    expect(projectMessage(null)).toEqual([]);
  });
});
