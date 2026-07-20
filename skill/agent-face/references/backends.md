# Backends — the brain contract

The face is stateless UI; its **brain** is pluggable behind one seam:
`POST /api/chat`. Two modes sit behind that seam.

- **Mode A — fresh hosted API.** Add a key and go: **Anthropic**, **OpenRouter**
  (also fronts Nous **Hermes** + hundreds of models), **Groq** (fast).
- **Mode B — bring your own running agent.** An **agent-bridge** attaches the
  face to an agent you already run, reusing its memory, tools, and persona.

Every variable below is **server-side only** and matches
[`../assets/app-template/.env.example`](../assets/app-template/.env.example)
(the canonical copy packaged with this skill) exactly. Keep
the three consistent.

---

## Mode A — hosted API brains

| Brain | Key | Default override | Runs on Vercel? |
|---|---|---|---|
| **Anthropic** (Claude) | `ANTHROPIC_API_KEY` | `ANTHROPIC_DEFAULT_MODEL` | ✅ |
| **OpenRouter** (→ Hermes + 100s) | `OPENROUTER_API_KEY` | `OPENROUTER_DEFAULT_MODEL` | ✅ |
| **Groq** (fast) | `GROQ_API_KEY` | `GROQ_DEFAULT_MODEL` | ✅ |

`GROQ_API_KEY` is dual-use: it also unlocks hosted Whisper STT in
`/api/transcribe`. `OPENAI_API_KEY` unlocks hosted STT + `gpt-4o-mini-tts`
voice-out but is **not** a chat brain.

Each adapter reads its key server-side, streams tokens, and honors an abort
signal for barge-in. The picker preselects the adapter's default model (or the
configured default-model override when set).

---

## Mode B — agent-bridge (reuse a running agent)

One adapter, several kinds, selected by `AGENT_BRIDGE_KIND`:

| Kind | Transport | Notes |
|---|---|---|
| `hermes` | Hermes `api_server` session flow | Stateful: creates a session, sends only the latest turn. Auth via `HERMES_API_BASE_URL` / `HERMES_API_KEY` (or `AGENT_BRIDGE_URL` / `AGENT_BRIDGE_KEY`) |
| `ollama` | `POST {url}/api/chat` (NDJSON stream) | Stateless: sends full history. Models via `{url}/api/tags`. URL defaults to `http://localhost:11434` |
| `openclaw` | `POST {url}/v1/chat/completions` (SSE) | OpenAI-compatible |
| `claude-code` | `POST {url}/v1/chat/completions` (SSE) | OpenAI-compatible local bridge |
| `openai-compatible` | `POST {url}/v1/chat/completions` (SSE) | Any OpenAI-shaped endpoint |

| Variable | Meaning |
|---|---|
| `AGENT_BRIDGE_KIND` | `hermes` \| `openclaw` \| `claude-code` \| `ollama` \| `openai-compatible` |
| `AGENT_BRIDGE_URL` | Base URL of the running agent |
| `AGENT_BRIDGE_KEY` | Auth token/key, if the agent requires one |
| `AGENT_BRIDGE_MODEL` | Model/thread the bridged agent should use, if applicable |
| `HERMES_API_BASE_URL` | Hermes alias for `AGENT_BRIDGE_URL` (used by the `hermes` kind) |
| `HERMES_API_KEY` | Hermes alias for `AGENT_BRIDGE_KEY` |

A stateful agent (like `hermes`) holds the thread itself, so the bridge sends
only the newest user turn and lets the agent's own memory carry context. A
stateless kind (`ollama`) receives the full history each call.

---

## Selection priority

When the user has **not** explicitly picked a brain, the first available option
wins, in this order:

```
1. ANTHROPIC        (ANTHROPIC_API_KEY present)
2. OPENROUTER       (OPENROUTER_API_KEY present)
3. GROQ             (GROQ_API_KEY present)
4. agent-bridge     (Mode B endpoint reachable + permitted)
```

An explicit UI pick always overrides this order.

---

## Reachability rules (Mode B)

- **Localhost dev** and **self-host / VPS**: a reachable endpoint is used
  directly — Mode B lives next to the agent over the private network, no tunnel.
  Set `SELF_HOST=1` when self-hosting so a private-network URL is allowed.
- **Vercel** (serverless): the agent-bridge is exposed **only** when
  `ALLOW_AGENT_BRIDGE_IN_PROD=1` **or** `AGENT_BRIDGE_URL` is a public HTTPS /
  tunnel URL. A serverless function cannot reach a private `localhost` address.

An unreachable endpoint surfaces a clear "agent offline" error and the Mode B
option simply does not appear in the settings panel.

---

## Graceful degradation

Every key is optional; no missing key hard-fails the UI.

| Missing | Behavior |
|---|---|
| No chat-brain key at all | UI shows "configure a brain or wire your running agent"; the face stays interactive and typing works once any brain exists |
| No `OPENAI_API_KEY` / `GROQ_API_KEY` | STT falls back to in-browser Whisper (WebGPU/WASM); TTS falls back to Web Speech — zero infra, zero cost |
| No `OPENAI_API_KEY` (TTS) | Voice-out uses Web Speech (mouth driven by an estimated envelope, not the FFT analyser) |
| Agent-bridge endpoint unreachable | The Mode B option does not appear in the picker |

---

## How to wire your own agent

1. Make sure your agent exposes a reachable HTTP endpoint (a Hermes `api_server`,
   an Ollama server, an openclaw / Claude Code bridge, or any OpenAI-compatible
   `/v1/chat/completions`).
2. In `.env.local`, set `AGENT_BRIDGE_KIND` to the matching kind and
   `AGENT_BRIDGE_URL` to the agent's base URL. Add `AGENT_BRIDGE_KEY` if it needs
   auth, and `AGENT_BRIDGE_MODEL` to pin a model/thread. For a Hermes
   `api_server` you can instead use `HERMES_API_BASE_URL` / `HERMES_API_KEY`.
3. Run `node skill/agent-face/scripts/check-env.mjs` to confirm the bridge is
   detected, then `node skill/agent-face/scripts/dev.mjs` and pick the
   agent-bridge brain in settings.
4. Deploying next to the agent? Self-host with `SELF_HOST=1` (private network) or,
   on Vercel with a public agent URL, set `ALLOW_AGENT_BRIDGE_IN_PROD=1`.

The bridge reuses the agent's own memory/tools — you are not resending a system
prompt for a stateful agent, you are talking to the agent you already run.

### `claude-code`: the local Agent SDK bridge

The agent-faces repo ships a ready-made local bridge for this kind at
`bridge/` (repo root, NOT part of this skill's app template): a small Node
server that wraps the Claude Agent SDK's `query()` behind
`/v1/chat/completions`, so the face talks to **your own Claude Code agent on
your own subscription login**.

Be precise about what "your own agent" means here (a real deployment got this
wrong): each turn spawns a **fresh** Agent SDK session. Its identity comes
entirely from that machine's Claude Code context — `CLAUDE.md`, memory files,
tools — not from any live conversation state. On a box with a rich setup it
answers like your agent; on a bare login it is stock Claude wearing the face
persona. For a face that answers as a **running** agent with live memory, use
the `hermes` / `openclaw` / `openai-compatible` kinds pointed at that agent's
own endpoint instead.

```bash
cd bridge && npm install && npm start        # 127.0.0.1:8787
# .env.local in the app:
AGENT_BRIDGE_KIND=claude-code
AGENT_BRIDGE_URL=http://127.0.0.1:8787
# optional shared secret (bridge side: CLAUDE_BRIDGE_TOKEN=<same value>):
# AGENT_BRIDGE_KEY=<value>
```

It is a LOCAL, personal-use dev tool: Anthropic does not allow offering
claude.ai login to third parties, so never deploy it as a user-facing feature.
It refuses to start while `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` are
exported (they would silently switch billing from your subscription to metered
API usage). Details and caveats: `bridge/README.md`.

---

## How to add a provider

Adding a brain is **one file + one registry line** — the `/api/chat` route never
learns a provider's name.

1. Create `lib/providers/<name>.ts` implementing the `ChatAdapter` seam:

   ```ts
   interface ChatAdapter {
     id: string;
     label: string;
     mode: 'A' | 'B';
     available(env): boolean;            // pure key/endpoint presence check
     listModels(env?): ModelInfo[] | Promise<ModelInfo[]>;
     streamChat(req, env?): AsyncIterable<StreamEvent>;  // delta | done | error
   }
   ```

   Reuse `lib/providers/sse.ts` (`parseSSEStream`) for OpenAI-style streams and
   throw a typed `AdapterError` on failure so the route maps it to a status code.
   Honor `req.signal` so barge-in aborts the upstream call.

2. Register it in `lib/providers/index.ts` with one line:

   ```ts
   registerAdapter('<name>', createYourAdapter);
   ```

That is the whole seam. `resolveAdapter`, `listAvailableAdapters`,
`selectDefaultAdapter`, `/api/chat`, and `/api/config` all pick it up
automatically. If your provider needs a new env variable, add it to
`.env.example` and `docs/env-contract.md` so the contract stays in one place.
