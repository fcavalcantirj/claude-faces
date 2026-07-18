---
name: agent-face
description: >-
  Gives an AI agent a talking, animated, lip-syncing voice face. You speak, it
  transcribes (in-browser Whisper), a pluggable brain replies, the reply is
  spoken back and drives a 12-emotion particle face with real audio-driven
  lip-sync. Ships as a Next.js web app you run on localhost, deploy to Vercel,
  or self-host next to your agent. USE WHEN the user wants to give their agent a
  face, talk to their agent by voice and watch it lip-sync, or deploy a voice
  face UI. Trigger phrases include "give my agent a face", "talk to my agent by
  voice", "deploy a face UI", "lip-sync face", "voice face for my agent", and
  "put a face on Hermes/openclaw". The brain can be a fresh hosted API OR your
  own already-running agent.
version: 0.1.0
license: MIT
metadata:
  brand: Claude Faces
  category: voice-ui
  package-manager: npm
---

# Agent Face

Give your agent a **face**. Talk to it out loud, hear it answer, and watch an
animated particle face lip-sync in real time.

This skill scaffolds, runs, and deploys a **Next.js web app** (a voice + face
front end). You speak → [Whisper](https://github.com/openai/whisper)
transcribes → your chosen **brain** replies → the reply is spoken back and
drives a ~4,700-particle 3D face with **12 emotions** and real audio-driven
lip-sync (`wawa-lipsync`).

> **North star:** *point this skill at an agent → boom, it has a face.* The
> face's brain can be a fresh hosted API **or your own already-running agent** —
> hosted on Vercel, or self-hosted on your VPS right next to the agent.

---

## When to use this skill

Use it when the user asks to:

- **"give my agent a face"** / **"put a face on Hermes/openclaw"** — attach a
  talking, animated face to an agent they already run (Mode B).
- **"talk to my agent by voice"** / **"I want to talk to it and see it
  lip-sync"** — a hands-free or push-to-talk voice loop with a lip-synced mouth.
- **"deploy a face UI"** / **"deploy a voice face to Vercel"** — scaffold and
  ship the app to Vercel or self-host.
- **"lip-sync face"** / **"voice face for my agent"** — a face UI whose mouth is
  driven by real audio.

**Do NOT use it** for unrelated "face" requests — generating a headshot photo,
building a face-recognition / face-detection model, or adding face tracking to a
camera app. See [`references/evaluations.md`](references/evaluations.md) for the
full should-trigger / should-not-trigger list.

---

## Overview

The face is **stateless UI**; its **brain** is pluggable behind one `/api/chat`
seam. Everything runs with **zero keys** (in-browser Whisper for speech-to-text,
the browser Web Speech API for speech-out); adding a key or wiring a running
agent unlocks hosted models and higher-fidelity FFT lip-sync.

- **Voice in:** in-browser Whisper (WebGPU + WASM fallback) by default; hosted
  fallback via Groq or OpenAI. Push-to-talk or hands-free VAD.
- **Voice out:** browser Web Speech API (zero infra) → upgrade to streamed
  OpenAI `gpt-4o-mini-tts` for real FFT-driven lip-sync (or all-local Kokoro on
  WebGPU).
- **Face:** a particle face with 12 emotions (`neutral, thinking, speaking,
  happy, alert, sad, angry, surprised, confused, sleepy, love, glitch`); the
  model can steer expression by emitting `[[face:happy]]`-style directives.

Deep dive: [`references/architecture.md`](references/architecture.md).

---

## Two brain modes

The one thing to decide first: **where does the reply come from?**

- **Mode A — fresh hosted API (works on Vercel, no agent needed).** Add a
  provider key and the app calls it directly: **Anthropic**, **OpenRouter**
  (also fronts Nous **Hermes** + hundreds of models), or **Groq** (fast
  inference). Just add a key.
- **Mode B — bring your own running agent.** An **agent-bridge** attaches the
  face to an agent you already run — **Hermes** `api_server`, **openclaw /
  nanoclaw**, a **local Claude Code bridge**, or **Ollama** — reusing that
  agent's memory, tools, and persona instead of a stateless call. Reachable on
  localhost / self-host directly, or from Vercel via a public HTTPS tunnel.

Full contract, per-kind wiring, and env names:
[`references/backends.md`](references/backends.md). Every key is server-side
only and optional; missing keys degrade gracefully.

---

## Operating flow

Follow this sequence. **Wait for and act on the user's answers** — do not assume
a default. (This flow is expanded with exact wording in a later task; the shape
is fixed here.)

1. **Check the environment.** Run `check-env.mjs` to see which brains, STT, and
   TTS are configured (secrets are always masked):
   ```bash
   node skill/agent-face/scripts/check-env.mjs
   ```
2. **Pick a brain.** If the host agent (Hermes / openclaw / Claude Code /
   Ollama) exposes a reachable endpoint, offer to wire the **agent-bridge**
   (Mode B) so the face reuses that agent as its brain. Otherwise fall back to a
   **Mode A** key. See [`references/backends.md`](references/backends.md).
3. **Ask: localhost first, or deploy?** Let the user choose to try it locally
   before shipping.
4. **If localhost** — start the dev server (it kills any previous server first),
   then open the browser and let the user talk to the face:
   ```bash
   node skill/agent-face/scripts/dev.mjs
   ```
5. **If deploy** — ask **Vercel (hosted) or self-host on your VPS?**, then:
   ```bash
   node skill/agent-face/scripts/deploy.mjs --target vercel      # hosted
   node skill/agent-face/scripts/deploy.mjs --target self-host   # Docker on your VPS
   ```

To scaffold the app into a fresh directory first (e.g. installing standalone):

```bash
node skill/agent-face/scripts/scaffold.mjs ./agent-face-app
```

---

## Scripts

All scripts are harness-agnostic Node ESM — plain `node`, no external deps.

| Script | Purpose |
|---|---|
| `scripts/scaffold.mjs` | Copy the app template into a target directory |
| `scripts/dev.mjs` | Kill any previous server, start dev, open the browser |
| `scripts/check-env.mjs` | Report which brains / STT / TTS are configured (secrets masked) |
| `scripts/deploy.mjs` | Deploy to Vercel or build the self-host image |

Run any of them with `--help` for options.

---

## Portability

The `skill/agent-face/` folder is a **portable Agent Skill** (the open
[Agent Skills](https://agentskills.io) standard). It uses **only
harness-agnostic `node` / `bash` scripts** — no Claude-specific tooling, no MCP
calls, no harness APIs — so it works on **Claude Code, Hermes, openclaw,
trustclaw, and nanoclaw**. Drop it into your harness's skills directory; the
harness discovers this `SKILL.md` and invokes the scripts with plain `node`.

Frontmatter uses only the portable/open subset (`name`, `description`,
`version`, `license`); any harness-specific keys live under `metadata`. The
harness matrix and per-harness invocation details are in
[`references/portability.md`](references/portability.md).

---

## References (progressive disclosure)

Load these only when you need the detail:

| Reference | Read it when |
|---|---|
| [`references/backends.md`](references/backends.md) | Wiring a brain — Mode A keys or a Mode B running agent, plus every env name |
| [`references/architecture.md`](references/architecture.md) | Understanding the mic → STT → `/api/chat` → TTS → lip-sync → face pipeline |
| [`references/deploy.md`](references/deploy.md) | Deploying to Vercel or self-hosting with Docker next to your agent |
| [`references/portability.md`](references/portability.md) | Running the skill on a non-Claude harness |
| [`references/evaluations.md`](references/evaluations.md) | Confirming when this skill should (and should not) trigger |

---

## Environment variables (all optional, server-side only)

| Var | Unlocks |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic chat brain (Mode A) |
| `OPENROUTER_API_KEY` | OpenRouter chat brain — Hermes + hundreds of models (Mode A) |
| `GROQ_API_KEY` | Groq chat brain + fast hosted Whisper STT (Mode A) |
| `OPENAI_API_KEY` | Hosted Whisper STT fallback + `gpt-4o-mini-tts` voice-out |
| `AGENT_BRIDGE_KIND` / `AGENT_BRIDGE_URL` / `AGENT_BRIDGE_KEY` | Wire the face to your running agent (Mode B) |
| `HERMES_API_BASE_URL` / `HERMES_API_KEY` | Hermes-compatible convenience aliases for Mode B |

Keys are **never** exposed to the browser (never `NEXT_PUBLIC_*`). Missing keys
degrade gracefully. Full contract: [`references/backends.md`](references/backends.md).
