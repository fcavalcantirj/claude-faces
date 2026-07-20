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
version: 0.2.0
license: MIT
metadata:
  brand: Agent Faces
  category: voice-ui
  package-manager: npm
---

# Agent Faces

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

## One command (quickstart)

Prerequisites: Node 20+ and npm, plus this repo
(`git clone https://github.com/fcavalcantirj/agent-faces`) or a previously
scaffolded app. Then, from the directory that holds the app:

```bash
node skill/agent-face/scripts/start.mjs      # app on :3000, bridge on :8787
```

It installs missing dependencies on first run (app AND bridge), frees the
ports, starts the local **agent bridge** if the checkout ships one (the
agent-faces repo does, under `bridge/`; the packaged app template
deliberately does not — see `bridge/README.md` for why), wires `.env.local`
(append-only — existing lines are never rewritten), starts the dev server,
and opens the face in your browser. **No bridge and no keys still opens a
working face** — voice in/out run entirely in the browser; a brain (key or
bridge) is only needed for intelligent replies.

**"Frees the ports" is identity-scoped:** only a process the launcher can
tie to THIS app (a stale dev server or bridge from a previous run, judged by
its working directory / command line) is auto-killed. Anything else holding
the port — say, another project's dev server on `:3000` — makes it **refuse
with exit 3** and print the holder's identity; pass `--port 3100` to run
elsewhere, or `--take-port` to kill the foreign process anyway. Other flags:
`--yolo` runs the bridge in `bypassPermissions` (owner's machine, no consent
clicks — a misheard sentence becomes an agent action), `--no-open` skips the
browser, `--stop` tears the whole stack down, `--help` lists the rest.

Starting from nothing instead of a checkout? Scaffold first, then start:

```bash
node skill/agent-face/scripts/scaffold.mjs ./agent-face-app
node skill/agent-face/scripts/start.mjs ./agent-face-app   # same flags: --port etc.
```

---

## When to use this skill

Use it when the user asks to:

- **"give my agent a face"** / **"put a face on Hermes/openclaw"** — attach a
  talking, animated face to an agent they already run (Mode B — "bring your own
  agent"; the modes are defined under **Two brain modes** below).
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
seam. **Zero keys still gets you a working face**: the particles render, the
mic transcribes (in-browser Whisper — the first "talk" downloads the model, so
give it a moment), and voice-out speaks via the browser. What zero keys does
NOT get you is an intelligent *reply* — that needs a brain: one hosted key
**or** your own running agent. (`check-env.mjs` exiting 1 means "no brain
yet", not "broken".) Voice in, voice out, and the face all run with **zero
keys** (in-browser Whisper for speech-to-text,
the browser Web Speech API for speech-out); adding a key or wiring a running
agent unlocks hosted models and higher-fidelity FFT lip-sync.

- **Voice in:** in-browser Whisper (WebGPU + WASM fallback) by default; hosted
  fallback via Groq or OpenAI. Push-to-talk or hands-free VAD
  (voice-activity detection — the mic listens continuously, no button).
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

**Wiring your own Claude Code agent (the North-Star case), in full:** this
uses the `bridge/` server at the agent-faces **repo root** — deliberately
outside this skill's app template (offering claude.ai login to third parties
needs Anthropic approval; running YOUR OWN agent on your own machine is fine).
`start.mjs` does all of this automatically when `bridge/` is present; by hand:

```bash
cd bridge && npm install && npm start        # 127.0.0.1:8787
# in the app's .env.local:
AGENT_BRIDGE_KIND=claude-code
AGENT_BRIDGE_URL=http://127.0.0.1:8787
```

Full contract, per-kind wiring, and env names:
[`references/backends.md`](references/backends.md). Every key is server-side
only and optional; missing keys degrade gracefully.

---

## Operating flow

Follow this sequence in order. **You MUST wait for and act on the user's answer
at each ASK step — never assume a default and never skip ahead.** Each numbered
step gates the next.

**1. Check the environment.** Run `check-env.mjs` to see which brains, STT, and
TTS are configured (secrets are always masked) before offering any brain:

```bash
node skill/agent-face/scripts/check-env.mjs
```

**2. Offer a brain (Mode B first, then Mode A).** If the host agent
(Hermes / openclaw / Claude Code / Ollama) exposes a **reachable endpoint**,
offer to wire the **agent-bridge** (Mode B) so the face reuses that agent as its
brain — its memory, tools, and persona. If no reachable agent endpoint exists,
fall back to a **Mode A** hosted key (Anthropic / OpenRouter / Groq). See
[`references/backends.md`](references/backends.md) for the per-kind wiring and
env names. Set the chosen brain's env vars, then re-run `check-env.mjs` to
confirm the brain is now detected.

**3. ASK the user, verbatim:**

> **Run on localhost to try it first, or deploy?**

Wait for the answer. **Do not assume** — the user may want to ship straight to
production or try locally first.

**4. ASK — only if they chose deploy — verbatim:**

> **Vercel (hosted) or self-host on your VPS?**

Wait for the answer before running any deploy command.

### Branch A — localhost

Start the dev server. **Mode B users run `start.mjs` here instead** — it
starts the bridge, then delegates to `dev.mjs`; `dev.mjs` alone starts only
the app. `dev.mjs` **always frees the dev port first** (SIGTERM then SIGKILL
a previous server of this same app; a foreign process on the port is refused
— use `--port` or `--take-port`) before spawning `npm run dev`, then opens
the browser. Let the user press **talk** and speak to the face:

```bash
node skill/agent-face/scripts/dev.mjs        # --port <n> if :3000 is taken
```

The app comes up on <http://localhost:3000> (or your `--port`). Have the user press **talk**, say
something, and confirm the transcript appears, the reply is spoken, and the face
morphs / lip-syncs.

### Branch B — deploy

First **confirm the environment** with `check-env.mjs` (a deploy with no brain
key still boots but has no working brain), then run **one** target depending on
the user's answer to step 4:

```bash
# They said "Vercel":
node skill/agent-face/scripts/deploy.mjs --target vercel      # hosted on Vercel

# They said "self-host":
node skill/agent-face/scripts/deploy.mjs --target self-host           # next build for your VPS
node skill/agent-face/scripts/deploy.mjs --target self-host --docker  # …as a Docker image
```

**After-deploy verification** — once the deploy prints a URL:

1. Open the deployed **URL** in a browser.
2. Press **talk** and speak a short phrase.
3. Confirm all three: the **transcript** of your speech appears, the brain's
   **spoken reply** plays, and the **face morphs** (emotion change +
   audio-driven lip-sync) while it speaks.

If Mode B was chosen, also confirm the reply reflects the running agent's memory
(self-host reaches it over the private network; Vercel needs a public HTTPS URL
or `ALLOW_AGENT_BRIDGE_IN_PROD=1`).

To scaffold the app into a fresh directory first (e.g. installing standalone):

```bash
node skill/agent-face/scripts/scaffold.mjs ./agent-face-app
```

---

## Scripts

All scripts are harness-agnostic Node ESM — plain `node`, no external deps.

| Script | Purpose |
|---|---|
| `scripts/start.mjs` | One command: bridge (if present) + dev server + browser; `--stop` tears it down |
| `scripts/scaffold.mjs` | Copy the app template into a target directory |
| `scripts/dev.mjs` | Free the dev port (kills only this app's own previous server; foreign holders are refused unless `--take-port`), start dev, open the browser |
| `scripts/check-env.mjs` | Report which brains / STT / TTS are configured (secrets masked) |
| `scripts/deploy.mjs` | Deploy to Vercel or build the self-host image |
| `scripts/hermes-serve.mjs` | Stand up a Hermes `api_server` for Mode B — never touches your live gateway |

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
| [`references/voice.md`](references/voice.md) | Voice in/out details — STT engines, TTS engines, env knobs |
| [`references/face.md`](references/face.md) | The particle face, emotions, and `[[face:…]]` directives |
| [`references/troubleshooting.md`](references/troubleshooting.md) | "Pressed talk, nothing happened" and every other stall |
| [`references/remote.md`](references/remote.md) | Opening the face from another machine (LAN/tailnet) — what needs HTTPS, one-command remedies |

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
| `ALLOW_AGENT_BRIDGE_IN_PROD` | `1` allows a non-public bridge URL in production (self-host / private network) |

Keys are **never** exposed to the browser (never `NEXT_PUBLIC_*`). Missing keys
degrade gracefully. Full contract: [`references/backends.md`](references/backends.md).
