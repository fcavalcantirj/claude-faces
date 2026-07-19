// Continuity digest — the bounded text preamble used when the live SDK
// session is gone (bridge restart, stale resume id) but the client's replayed
// history shows a conversation in progress. Mirrors hermes-agent's
// _render_continuity_digest: last N user/assistant turns, per-message and
// total character caps, wrapped in explicit markers so the agent knows it is
// reading a reconstruction, not a live transcript.

import { flattenContent } from "./openai-http.mjs";

const HEADER =
  "[Continuity digest — the live bridge session was lost (restart or expired resume); " +
  "the tail of the prior conversation follows]";
const FOOTER = "[End of continuity digest]";

/** Build the digest from OpenAI-shaped messages; "" when nothing to carry. */
export function buildContinuityDigest(
  messages,
  { tailTurns = 8, perMessageChars = 400, maxChars = 4000 } = {},
) {
  const turns = (Array.isArray(messages) ? messages : []).filter(
    (m) => m && (m.role === "user" || m.role === "assistant"),
  );
  if (turns.length === 0) return "";

  const lines = turns
    .slice(-tailTurns)
    .map((m) => `${String(m.role).toUpperCase()}: ${flattenContent(m.content).slice(0, perMessageChars)}`);

  let body = `${HEADER}\n${lines.join("\n")}`;
  if (body.length > maxChars) body = body.slice(0, maxChars);
  return `${body}\n${FOOTER}`;
}
