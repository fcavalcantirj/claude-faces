// Parsing for the OpenAI-compatible surface. The face's agent-bridge adapter
// sends { model, messages, max_tokens, stream, temperature }; max_tokens and
// temperature are accepted and IGNORED (the Agent SDK has no such knobs) —
// tolerating any well-formed OpenAI client is part of the contract, so unknown
// fields are never a 400.

/** An HTTP-mappable error with an OpenAI-style error type. */
export class HttpError extends Error {
  constructor(status, message, type) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.type =
      type ??
      (status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "invalid_request_error");
  }
}

/** OpenAI-style error body. */
export function errorBody(err) {
  return {
    error: {
      message: err?.message ?? "Internal error.",
      type: err instanceof HttpError ? err.type : "server_error",
    },
  };
}

/** Flatten OpenAI message content (string or array-of-parts) to plain text. */
export function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === "object" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

/**
 * Validate and destructure a chat-completions request body.
 * Returns { model, stream, systemText, messages, latestUserText, hasAssistantTurns }
 * where `messages` is the conversation with system messages split out.
 */
export function parseChatRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  const raw = body.messages;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, "Request must include a non-empty messages array.");
  }

  const systemParts = [];
  const messages = [];
  for (const m of raw) {
    if (!m || typeof m !== "object" || typeof m.role !== "string" || !m.role) {
      throw new HttpError(400, "Every message needs a string role.");
    }
    if (m.content === undefined || m.content === null) {
      throw new HttpError(400, "Every message needs content.");
    }
    if (m.role === "system") systemParts.push(flattenContent(m.content));
    else messages.push(m);
  }

  let latestUserText = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      latestUserText = flattenContent(messages[i].content);
      break;
    }
  }
  if (latestUserText === null) {
    throw new HttpError(400, "Request contains no user message to answer.");
  }

  return {
    model: typeof body.model === "string" && body.model ? body.model : "default",
    stream: body.stream !== false,
    systemText: systemParts.join("\n\n"),
    messages,
    latestUserText,
    hasAssistantTurns: messages.some((m) => m.role === "assistant"),
  };
}
