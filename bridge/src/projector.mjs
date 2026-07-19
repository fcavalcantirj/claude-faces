// SDK message → bridge event projection. Duck-typed on `message.type` (like
// hermes-agent's projector) so a fake SDK in tests and version drift in the
// real one degrade gracefully instead of crashing.
//
// TEXT ONLY, by design. Server-side tools (server_tool_use — web_search,
// web_fetch) return their results inside the SAME assistant message, never as
// a {role:'tool'} echo; projecting them as OpenAI tool_calls would persist a
// dangling tool_call_id that breaks the client's full-history replay. The
// face client only ever reads choices[0].delta.content, so nothing is lost.
//
// Emitted events:
//   {type:'session', sessionId}                       — id to resume with
//   {type:'delta', text}                              — live streamed text
//   {type:'assistant_text', text}                     — fallback when not streaming
//   {type:'result', finishReason, isError, text, usage} — end of turn

function textBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function mapUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const prompt = Number(usage.input_tokens) || 0;
  const completion = Number(usage.output_tokens) || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function mapFinishReason(subtype) {
  return subtype === "error_max_turns" ? "length" : "stop";
}

/** Project one SDK message into zero or more bridge events. */
export function projectMessage(message) {
  if (!message || typeof message !== "object") return [];

  // Anything attributed to a subagent (parent_tool_use_id) is inner monologue:
  // forwarding it floods the user with text the top-level agent never said.
  const fromSubagent = Boolean(message.parent_tool_use_id);

  switch (message.type) {
    case "system":
      return message.subtype === "init" && message.session_id
        ? [{ type: "session", sessionId: message.session_id }]
        : [];

    case "stream_event": {
      if (fromSubagent) return [];
      const event = message.event;
      if (!event || event.type !== "content_block_delta") return [];
      const delta = event.delta;
      if (!delta || delta.type !== "text_delta" || !delta.text) return [];
      return [{ type: "delta", text: delta.text }];
    }

    case "assistant": {
      if (fromSubagent) return [];
      const text = textBlocks(message.message?.content);
      return text ? [{ type: "assistant_text", text }] : [];
    }

    case "result": {
      const events = [];
      if (message.session_id) events.push({ type: "session", sessionId: message.session_id });
      events.push({
        type: "result",
        finishReason: mapFinishReason(message.subtype),
        isError: message.is_error === true || Boolean(message.subtype && message.subtype !== "success"),
        text: typeof message.result === "string" ? message.result : null,
        usage: mapUsage(message.usage),
      });
      return events;
    }

    default:
      return [];
  }
}
