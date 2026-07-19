// The ONLY module that names the real SDK. Everything else receives the query
// function by injection, so the whole bridge is unit-testable with a scripted
// fake — the real @anthropic-ai/claude-agent-sdk spawns a Claude Code CLI
// subprocess and needs a subscription login, which only the human UAT pass
// exercises.

export async function loadQuery() {
  let mod;
  try {
    mod = await import("@anthropic-ai/claude-agent-sdk");
  } catch (err) {
    throw new Error(
      "Cannot load @anthropic-ai/claude-agent-sdk — run `npm install` inside bridge/ first. " +
        `(${err?.message ?? err})`,
    );
  }
  if (typeof mod.query !== "function") {
    throw new Error(
      "The installed @anthropic-ai/claude-agent-sdk exports no query() function — version mismatch? " +
        "This bridge was written against the query() async-generator API documented at " +
        "code.claude.com/docs/en/agent-sdk.",
    );
  }
  return mod.query;
}
