# claude-agent-bridge

A **local, personal-use** bridge that puts **your own Claude Code agent** behind an
OpenAI-compatible `POST /v1/chat/completions` (SSE), so the agent-faces app can use it as a
brain via `AGENT_BRIDGE_KIND=claude-code`. Your conversation runs on **your own Claude
subscription login** — with your agent's memory, tools, and filesystem access.

## Read this first — what this is NOT

Anthropic's Agent SDK documentation states:

> "Unless previously approved, Anthropic does not allow third party developers to offer
> claude.ai login or rate limits for their products, including agents built on the Claude
> Agent SDK. Please use the API key authentication methods described in this document instead."

This bridge is therefore **not a user-facing auth feature, not a hosted service, and not a
Vercel route**. It binds `127.0.0.1` by default and is meant to stay on the operator's own
machine, fronting the operator's own agent. Shipping subscription login to *your users*
requires Anthropic's approval — don't.

Also understand the tradeoff: unlike a stateless API brain, this hands the browser face a
**real agent with tools and filesystem access**. More powerful, and more dangerous — treat the
permission mode and the bind address accordingly.

## Auth model (fail-closed)

The bridge holds **no credentials**. The Agent SDK spawns a Claude Code CLI subprocess that
self-authenticates from `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) or the `~/.claude`
credential store — i.e. your existing subscription login. The launcher
(`skill/agent-face/scripts/start.mjs`) forwards a `CLAUDE_CODE_OAUTH_TOKEN` found in the
app's `.env.local` (e.g. set via the GUI's SERVER ENV editor) into the bridge child —
the bridge itself never reads env files, and the metered-key scrub still runs last.

**The bridge refuses to start while `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is
exported.** The CLI silently *prefers* a key over the subscription, which would flip billing
from "included in your plan" to metered API usage with no visible signal. If you truly want
metered billing, say so explicitly with `CLAUDE_BRIDGE_ALLOW_API_KEY=1`.
(This guard is ported from hermes-agent, where it exists for exactly this reason.)

## Quickstart

```bash
cd bridge
npm install
npm start                          # http://127.0.0.1:8787

# in the agent-faces app's .env.local:
AGENT_BRIDGE_KIND=claude-code
AGENT_BRIDGE_URL=http://127.0.0.1:8787
```

Smoke-test without the app:

```bash
curl -s http://127.0.0.1:8787/healthz
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"say hi in five words"}],"stream":false}'
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `CLAUDE_BRIDGE_PORT` | `8787` | Listen port |
| `CLAUDE_BRIDGE_HOST` | `127.0.0.1` | Bind address — think hard before widening it |
| `CLAUDE_BRIDGE_TOKEN` | *(none)* | If set, requests must send `Authorization: Bearer <token>` (app side: `AGENT_BRIDGE_KEY`) |
| `CLAUDE_BRIDGE_MODEL` | SDK default | Model override passed to the SDK |
| `CLAUDE_BRIDGE_PERMISSION_MODE` | `acceptEdits` | SDK permission mode (`default`, `acceptEdits`, `bypassPermissions`) |

**Permission mode, in practice**: the default `acceptEdits` auto-approves file edits but NOT
command execution — headless, those requests are denied, so the agent says things like "the
sandbox asked for permission, so it got blocked". If you are the operator using your own agent
and want it to actually run things (`npm run start:yolo`, or set
`CLAUDE_BRIDGE_PERMISSION_MODE=bypassPermissions`), understand what that means **on a
voice-driven interface**: a misheard sentence becomes an agent action with no confirmation
click. Owner's machine, owner's rules — but that is the trade.
| `CLAUDE_BRIDGE_CWD` | *(none)* | Working directory for the agent |
| `CLAUDE_BRIDGE_ALLOW_API_KEY` | off | Explicitly allow metered-key billing (see above) |
| `CLAUDE_BRIDGE_WARM` | on | `0` reverts to one CLI subprocess per turn (the pre-warm behavior) — rollback lever if the warm session misbehaves |

## Behaviour notes

- **Warm session**: the bridge holds ONE streaming-input SDK query open across turns, so
  follow-up turns skip the CLI subprocess spawn (~1.1–2.0s each, measured 2026-07-20).
  A conversation reset (history with no assistant turns) closes the warm query and opens
  a fresh one — old context can never bleed into a new conversation. A changed system
  prompt also recycles the query (`resume` carries the context across), so a persona
  that varies per request silently costs a respawn every turn — keep it stable.
  `[bridge-timing]` lines carry `warm:true/false` per attempt; `initMs` only exists on
  opening (cold) attempts.
- **Sessions**: OpenAI clients replay full history; the bridge sends only the latest user
  message — into the open query while it lives, via `resume` when rebuilding after a
  failure, abort, timeout, or restart. If no resume id is stored, the rebuild goes fresh
  with a bounded *continuity digest* of the replayed tail; a stale resume id is retired
  after one failed attempt.
- **Text only**: no OpenAI `tool_calls` are ever emitted. Server-side tools (web search etc.)
  deliver their results inside the assistant text; projecting them as `tool_calls` would
  create dangling `tool_call_id`s on replay. The face only reads `delta.content` anyway.
- **One turn at a time**: a concurrent second request briefly waits, then gets `429`.
- **Barge-in**: client disconnect aborts the turn and closes the warm query (its CLI
  subprocess included) immediately; the NEXT turn rebuilds via `resume`, so an
  interrupted conversation keeps its context at the cost of one respawn.
- **Keepalive**: `: keepalive` SSE comments every 30s of silence keep proxies from killing
  long thinking/tool turns.
- The SDK message shapes this bridge projects were written against the Agent SDK docs as of
  2026-07 and are duck-typed defensively; if a future SDK renames fields, the unit tests in
  `test/` encode the expected shapes.
