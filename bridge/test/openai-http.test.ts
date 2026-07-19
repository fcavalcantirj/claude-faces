// @vitest-environment node
//
// Request parsing for the OpenAI subset the face's agent-bridge adapter sends:
// { model, messages, max_tokens, stream, temperature }. Unknown knobs are
// accepted and ignored (the Agent SDK has no temperature/max_tokens), never a
// 400 — the bridge must tolerate any well-formed OpenAI client.

import { describe, it, expect } from "vitest";
import { parseChatRequest, HttpError } from "../src/openai-http.mjs";

describe("parseChatRequest", () => {
  it("parses the exact shape lib/providers/agent-bridge.ts sends", () => {
    const parsed = parseChatRequest({
      model: "default",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "how are you?" },
      ],
      max_tokens: 4096,
      stream: true,
      temperature: 0.5,
    });
    expect(parsed.model).toBe("default");
    expect(parsed.stream).toBe(true);
    expect(parsed.systemText).toBe("be brief");
    expect(parsed.latestUserText).toBe("how are you?");
    expect(parsed.hasAssistantTurns).toBe(true);
    expect(parsed.messages).toHaveLength(3); // system messages split out
  });

  it("flattens array-of-parts content", () => {
    const parsed = parseChatRequest({
      messages: [{ role: "user", content: [{ type: "text", text: "part a" }, { type: "text", text: "part b" }] }],
    });
    expect(parsed.latestUserText).toBe("part a\npart b");
  });

  it("defaults stream to true and model to 'default'", () => {
    const parsed = parseChatRequest({ messages: [{ role: "user", content: "x" }] });
    expect(parsed.stream).toBe(true);
    expect(parsed.model).toBe("default");
  });

  it("joins multiple system messages", () => {
    const parsed = parseChatRequest({
      messages: [
        { role: "system", content: "one" },
        { role: "system", content: "two" },
        { role: "user", content: "x" },
      ],
    });
    expect(parsed.systemText).toBe("one\n\ntwo");
  });

  it("400s on a non-object body", () => {
    expect(() => parseChatRequest(null)).toThrow(HttpError);
    expect(() => parseChatRequest("nope")).toThrow(/JSON object/);
  });

  it("400s on missing/empty messages", () => {
    expect(() => parseChatRequest({})).toThrow(/messages/);
    expect(() => parseChatRequest({ messages: [] })).toThrow(/messages/);
  });

  it("400s when there is no user message to answer", () => {
    expect(() => parseChatRequest({ messages: [{ role: "system", content: "s" }] })).toThrow(
      /user message/,
    );
  });

  it("400s on a malformed message entry", () => {
    expect(() => parseChatRequest({ messages: [{ role: "user" }] })).toThrow(/content/);
    expect(() => parseChatRequest({ messages: [{ content: "x" }] })).toThrow(/role/);
  });

  it("carries an HTTP status on parse errors", () => {
    try {
      parseChatRequest({});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as HttpError).status).toBe(400);
    }
  });
});
