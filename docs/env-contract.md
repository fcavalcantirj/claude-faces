# Environment Contract

The single source of truth for **every** environment variable claude-faces
reads, what unlocks what, and how the brain is selected. Keep this file,
[`.env.example`](../.env.example), the `/api/config` probe, the
`skill/agent-face/scripts/check-env.mjs` script, and
`skill/agent-face/references/backends.md` **consistent** — they must all use the
exact names below.

> **Security rule (non-negotiable):** every variable here is **server-side
> only**. They are read exclusively inside Next.js route handlers (`app/api/*`).
> **Never** prefix any of them with `NEXT_PUBLIC_` — that ships the secret to
> the browser. The client learns *whether* a capability exists via `/api/config`
> (booleans only), never the values.

Every key is **optional**; the app degrades gracefully (see
[Graceful degradation](#graceful-degradation)).

---

## Chat-brain selection priority

When the user has **not** explicitly picked a brain in the settings panel, the
first available option in this order is used:

```
1. ANTHROPIC        (ANTHROPIC_API_KEY present)
2. OPENROUTER       (OPENROUTER_API_KEY present)
3. GROQ             (GROQ_API_KEY present)
4. agent-bridge     (Mode B endpoint reachable + permitted)
```

An **explicit user pick** in the UI always wins over this default order. If no
option in the list is available, the UI shows a "configure a brain or wire your
running agent" state and keeps the face interactive.

---

## Mode A — fresh API brains (hosted; work on Vercel)

| Variable | Unlocks | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) chat brain | Highest priority when set |
| `ANTHROPIC_DEFAULT_MODEL` | Default Anthropic model in the picker | Optional override |
| `OPENROUTER_API_KEY` | OpenRouter chat brain (Hermes + hundreds of models) | |
| `OPENROUTER_DEFAULT_MODEL` | Default OpenRouter model in the picker | Optional override |
| `GROQ_API_KEY` | Groq chat brain **and** hosted Whisper STT | One key, two capabilities |
| `GROQ_DEFAULT_MODEL` | Default Groq model in the picker | Optional override |
| `OPENAI_API_KEY` | Hosted Whisper STT fallback **and** `gpt-4o-mini-tts` voice-out | |

---

## Mode B — agent-bridge (reuse a running agent as the brain)

Wire the face to an agent you already run so it reuses that agent's memory,
tools, and persona instead of a stateless API call.

| Variable | Meaning |
|---|---|
| `AGENT_BRIDGE_KIND` | Which running agent to bridge to: `hermes` \| `openclaw` \| `claude-code` \| `ollama` \| `openai-compatible` |
| `AGENT_BRIDGE_URL` | Base URL of the running agent (e.g. `http://localhost:11434` for Ollama) |
| `AGENT_BRIDGE_KEY` | Auth token/key for the bridged agent, if required |
| `AGENT_BRIDGE_MODEL` | Model/thread the bridged agent should use, if applicable |
| `HERMES_API_BASE_URL` | Hermes-compatible alias for `AGENT_BRIDGE_URL` (used by the `hermes` kind) |
| `HERMES_API_KEY` | Hermes-compatible alias for `AGENT_BRIDGE_KEY` |

**Reachability rules:**

- On **localhost dev** and **self-host / VPS**, a reachable endpoint is usable
  directly (Mode B lives next to the agent over the private network — no tunnel).
- On **Vercel** (serverless), the agent-bridge is exposed **only** when
  `ALLOW_AGENT_BRIDGE_IN_PROD=1` **or** `AGENT_BRIDGE_URL` is a public HTTPS /
  tunnel URL. A serverless function cannot reach a private `localhost` address.

---

## Hosted STT tuning knobs

Tune the OpenAI hosted-transcription fallback in `/api/transcribe`. (Groq STT
uses `whisper-large-v3-turbo` automatically whenever `GROQ_API_KEY` is set.)

| Variable | Meaning | Default |
|---|---|---|
| `OPENAI_TRANSCRIBE_MODEL` | OpenAI transcription model | `whisper-1` |
| `OPENAI_TRANSCRIBE_LANGUAGE` | Force a transcription language (ISO-639-1); blank = auto-detect | *(auto)* |
| `OPENAI_TRANSCRIBE_PROMPT` | Optional vocab/style prompt to bias transcription | *(none)* |

---

## Deploy knobs

| Variable | Meaning |
|---|---|
| `SELF_HOST` | Set to `1` when self-hosting (Docker on your own VPS); relaxes Vercel-only assumptions so Mode B can reach a private-network URL |
| `ALLOW_AGENT_BRIDGE_IN_PROD` | Set to `1` to allow the agent-bridge in production when the URL is a known public HTTPS/tunnel |

---

## Graceful degradation

| Missing | Behavior |
|---|---|
| No chat-brain key at all | UI shows "configure a brain or wire your running agent"; face stays interactive |
| No `OPENAI_API_KEY` / `GROQ_API_KEY` | STT falls back to in-browser Whisper (WebGPU/WASM); TTS falls back to browser Web Speech API — zero infra, zero cost |
| No `OPENAI_API_KEY` (TTS) | Voice-out uses Web Speech API (mouth driven by an estimated envelope instead of the FFT analyser) |
| Agent-bridge endpoint unreachable | The Mode B option simply does not appear in the settings panel |

No missing key ever hard-fails the UI: each absent capability shows an
explanatory, actionable message and typing-to-chat keeps working whenever any
brain is available.
