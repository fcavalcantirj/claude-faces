<div align="center">

<img src="public/icon.svg" width="110" alt="Agent Faces logo">

# Agent Faces

**Give your AI agent a face it can talk through.**

You speak → Whisper hears you → your agent answers → a ~4,700-particle face
speaks the reply out loud, lip-syncing to the real audio, with **12 emotions** it steers itself.

[![CI](https://github.com/fcavalcantirj/claude-faces/actions/workflows/ci.yml/badge.svg)](https://github.com/fcavalcantirj/claude-faces/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-8A2BE2)](CONTRIBUTING.md)

[Quick start](#-60-second-start) · [Two brains](#-two-brains) · [Voice & face](#%EF%B8%8F-voice--face) · [Deploy](#-deploy--your-pick) · [The skill](#-install-the-skill) · [How it was built](#-how-this-was-built)

![Agent Faces demo — 12-emotion particle face](public/screenshots/demo.gif)

</div>

> **The north star:** *point Agent Faces at an agent → boom, it has a face.* The brain can be
> a fresh API key **or the agent you already run** — with its memory, its tools, its persona.
> Hosted on Vercel, or self-hosted right next to your agent.

---

## ⚡ 60-second start

```bash
git clone https://github.com/fcavalcantirj/claude-faces.git
cd claude-faces
node skill/agent-face/scripts/start.mjs    # installs deps, wires env, starts everything, opens the face
```

Press **talk**. That's it.

**Zero keys? Still works.** Speech-to-text runs on **in-browser Whisper** (WebGPU — private,
offline, $0) and speech-out uses the browser's **Web Speech API**. Add one key — or point it
at an agent you already run — to unlock hosted models and FFT-grade lip-sync.

<details>
<summary>Prefer the manual route?</summary>

```bash
npm install
cp .env.example .env.local     # add ≥1 provider key OR wire your running agent (both optional)
npm run dev                    # http://localhost:3000, press "talk"
```
</details>

---

## 🧠 Two brains

The face is stateless UI; its **brain** is pluggable behind one `/api/chat` seam.

- **Mode A — fresh API** (works on Vercel, no agent needed): **Anthropic**, **OpenRouter**
  (fronts Nous **Hermes** + hundreds of models), **Groq** (fast inference). Just add a key.
- **Mode B — bring your own running agent.** This is the one nobody else does: an
  **agent-bridge** attaches the face to an agent you already run — **Hermes** `api_server`,
  **openclaw / nanoclaw**, a **local Claude Code bridge**, or **Ollama** — so the face answers
  with *that agent's* memory, tools, and persona instead of a stateless completion.

| Brain | Kind | Env | Runs on Vercel? |
|---|---|---|---|
| Anthropic | Mode A | `ANTHROPIC_API_KEY` | ✅ |
| OpenRouter (→ Hermes, +100s) | Mode A | `OPENROUTER_API_KEY` | ✅ |
| Groq (fast) | Mode A | `GROQ_API_KEY` | ✅ |
| Agent-bridge → Hermes / openclaw / Claude Code / Ollama | Mode B | `AGENT_BRIDGE_*` / `HERMES_API_*` | If the agent is reachable (self-host / HTTPS tunnel) |

Full contract + per-agent wiring: [`skill/agent-face/references/backends.md`](skill/agent-face/references/backends.md).

---

## 🎙️ Voice & face

- **Voice in** — in-browser Whisper (`@huggingface/transformers`, WebGPU + WASM fallback);
  hosted fallback via Groq `whisper-large-v3-turbo` or OpenAI `gpt-4o-transcribe`.
  **Push-to-talk or hands-free** (voice-activity detection — no button, just talk).
- **Voice out** — browser Web Speech (zero infra) → streamed OpenAI `gpt-4o-mini-tts` for real
  FFT-driven lip-sync → or **Kokoro**, fully local on WebGPU.
- **The face** — ~4,700 particles, 12 emotions
  (`neutral thinking speaking happy alert sad angry surprised confused sleepy love glitch`),
  mouth driven by the actual audio via `wawa-lipsync`. The model steers its own expression by
  emitting `[[face:happy]]`-style directives mid-reply.

![Agent Faces speaking](public/screenshots/talking.png)

---

## 🚀 Deploy — your pick

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/fcavalcantirj/claude-faces&env=ANTHROPIC_API_KEY,OPENROUTER_API_KEY,GROQ_API_KEY,OPENAI_API_KEY&envDescription=All%20optional%20%E2%80%94%20the%20app%20falls%20back%20to%20browser%20Whisper%20%2B%20Web%20Speech%20if%20none%20are%20set&envLink=https://github.com/fcavalcantirj/claude-faces/blob/main/skill/agent-face/references/backends.md&project-name=claude-faces&repository-name=claude-faces)

- **Vercel** — the button above, or `node skill/agent-face/scripts/deploy.mjs --target vercel`.
  All keys optional; Mode B is wired after deploy (it needs a reachable agent).
- **Self-host** — `node skill/agent-face/scripts/deploy.mjs --target self-host` builds a
  Docker image you run on your VPS *next to your agent*, so the bridge talks over the private
  network with no tunnel.

Details: [`skill/agent-face/references/deploy.md`](skill/agent-face/references/deploy.md).

---

## 🧩 Install the skill

`skill/agent-face/` is a **portable Agent Skill** (open [Agent Skills](https://agentskills.io)
standard) — plain `node` scripts, no harness-specific tooling. Drop it into the skills
directory of **Claude Code, Hermes, openclaw, trustclaw, or nanoclaw** and the agent gains the
ability to scaffold, run, and deploy its own face:

| Script | Purpose |
|---|---|
| `scripts/start.mjs` | One command: bridge (if present) + dev server + browser; `--stop` tears it down |
| `scripts/scaffold.mjs` | Copy the app template into a target dir |
| `scripts/dev.mjs` | Free the dev port (kills only this app's own previous server; foreign holders refused unless `--take-port`), start dev, open the browser |
| `scripts/check-env.mjs` | Report which brains/STT/TTS are configured (secrets masked) |
| `scripts/deploy.mjs` | Deploy to Vercel or build the self-host image |

Portability matrix: [`skill/agent-face/references/portability.md`](skill/agent-face/references/portability.md).

---

## 🏗️ Architecture

```
Browser (Next.js on Vercel CDN, or self-hosted next to your agent)
  mic → Whisper (browser WebGPU / hosted) → /api/chat (your brain) → TTS → wawa-lipsync → 12-emotion face
                                             ↑ keys + provider fan-out live server-side (thin, ~free)
```

All provider keys are **server-side only** — never `NEXT_PUBLIC_*`. Missing keys degrade
gracefully. Deep dive: [`skill/agent-face/references/architecture.md`](skill/agent-face/references/architecture.md).

<details>
<summary>Environment variables (all optional)</summary>

| Var | Unlocks |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) chat brain |
| `OPENROUTER_API_KEY` | OpenRouter chat brain (Hermes + hundreds of models) |
| `GROQ_API_KEY` | Groq chat brain + fast hosted Whisper STT |
| `OPENAI_API_KEY` | Hosted Whisper STT + `gpt-4o-mini-tts` voice-out |
| `AGENT_BRIDGE_KIND` / `AGENT_BRIDGE_URL` / `AGENT_BRIDGE_KEY` | Mode B: wire the face to your running agent |
| `HERMES_API_BASE_URL` / `HERMES_API_KEY` | Mode B convenience for a Hermes `api_server` |

Full list in [`.env.example`](.env.example).
</details>

---

## 🤖 How this was built

Most of this repo was written **autonomously, overnight, by a loop of stateless coding-agent
runs** — and the harness is still here, on purpose, because it's the story:

- [`prd.json`](prd.json) — the 70-task ledger that drove the build
- [`progress.txt`](progress.txt) — the agents' append-only journal (their durable memory between runs)
- `ralph.sh` / `ralph-continuous.sh` — the loop drivers; `./progress.sh` prints the ledger state any time

Each iteration did exactly one task test-first, ran that task's own verification, journaled,
committed, and stopped. Six CI gates (lint, typecheck, unit tests + coverage, build, skill
smoke tests, app-template parity) plus a Playwright browser e2e suite guard `main`.

---

<div align="center">

**If a talking face for your agent is something the world needs — [star the repo ⭐](https://github.com/fcavalcantirj/claude-faces/stargazers) and say hi.**

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [MIT License](LICENSE)

</div>
