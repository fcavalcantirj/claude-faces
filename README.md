# Claude Faces 🗣️😃

**Give your agent a face.** Talk to it out loud, hear it answer, and watch an animated face lip-sync in real time.

Claude Faces is a **portable Agent Skill** + a **Next.js web app**. Install the skill on any skill-pattern agent (Claude Code, Hermes, openclaw, trustclaw, nanoclaw…), and it scaffolds, runs, and deploys a voice+face front end. You speak → [OpenAI Whisper](https://github.com/openai/whisper) transcribes → your chosen **brain** replies → the reply is spoken back and drives a 12-emotion particle face.

> **The north star:** *install the skill on an agent → boom, it has a face.* The face's brain can be a fresh API **or your own already-running agent** — hosted on Vercel, or self-hosted on your own VPS right next to the agent.

![Claude Faces hero](public/screenshots/hero.png)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/fcavalcantirj/claude-faces&env=ANTHROPIC_API_KEY,OPENROUTER_API_KEY,GROQ_API_KEY,OPENAI_API_KEY&envDescription=All%20optional%20%E2%80%94%20the%20app%20falls%20back%20to%20browser%20Whisper%20%2B%20Web%20Speech%20if%20none%20are%20set&envLink=https://github.com/fcavalcantirj/claude-faces/blob/main/skill/agent-face/references/backends.md&project-name=claude-faces&repository-name=claude-faces)

---

## Quick start (localhost)

```bash
git clone https://github.com/fcavalcantirj/claude-faces.git
cd claude-faces
npm install
cp .env.example .env.local     # add ≥1 provider key, OR point it at your running agent (both optional)
npm run dev                    # open http://localhost:3000 and press "talk"
```

With **zero keys** it still runs: speech-to-text uses **in-browser Whisper** (WebGPU, private, offline) and speech-out uses the browser **Web Speech API**. Add a key or wire a local agent to unlock hosted models and higher-fidelity lip-sync.

---

## Two brains

The face is stateless UI; its **brain** is pluggable behind one `/api/chat` seam.

- **Mode A — fresh API (works on Vercel, no agent needed):** **Anthropic**, **OpenRouter** (also fronts Nous **Hermes** + hundreds of models), **Groq** (fast inference). Just add a key.
- **Mode B — bring your own running agent:** an **agent-bridge** attaches the face to an agent you already run — **Hermes** `api_server`, **openclaw / nanoclaw**, a **local Claude Code bridge**, or **Ollama** — reusing that agent's memory, tools, and persona instead of a stateless call. Reachable on localhost/self-host directly, or from Vercel via an HTTPS tunnel.

| Brain | Kind | Env | Runs on Vercel? |
|---|---|---|---|
| Anthropic | Mode A | `ANTHROPIC_API_KEY` | ✅ |
| OpenRouter (→ Hermes, +100s) | Mode A | `OPENROUTER_API_KEY` | ✅ |
| Groq (fast) | Mode A | `GROQ_API_KEY` | ✅ |
| Agent-bridge → Hermes / openclaw / Claude Code / Ollama | Mode B | `AGENT_BRIDGE_*` / `HERMES_API_*` | Only if the agent is reachable (self-host, or HTTPS tunnel) |

See [`skill/agent-face/references/backends.md`](skill/agent-face/references/backends.md) for the full contract and how to wire your own agent.

---

## Voice & face

- **Voice in:** in-browser Whisper (`@huggingface/transformers`, WebGPU + WASM fallback) by default; hosted fallback via **Groq `whisper-large-v3-turbo`** or **OpenAI `gpt-4o-transcribe`**. Push-to-talk or hands-free VAD.
- **Voice out:** browser **Web Speech API** (zero infra) → upgrade to streamed **OpenAI `gpt-4o-mini-tts`** for real FFT-driven lip-sync (or all-local **Kokoro** on WebGPU).
- **Face:** a ~4,700-particle 3D face with 12 emotions (`neutral, thinking, speaking, happy, alert, sad, angry, surprised, confused, sleepy, love, glitch`). Its mouth is driven by real audio via `wawa-lipsync`; the model can steer expression by emitting `[[face:happy]]`-style directives.

---

## Deploy — your pick

The skill **asks** whether you want to run on localhost first, then where to deploy:

- **Vercel** (hosted) — click the button above, or run `node skill/agent-face/scripts/deploy.mjs --target vercel`. All four env keys are optional and prompted at clone time. Only the four **Mode A** keys are prompted; Mode B (bring-your-own agent) is wired *after* deploy, since it needs a reachable agent. The button's `repository-url` must point at the final public GitHub repo once pushed (currently `github.com/fcavalcantirj/claude-faces`) — update it if you fork or rename.
- **Self-host** — `node skill/agent-face/scripts/deploy.mjs --target self-host` builds a Docker image you run on your own VPS *next to your agent*, so Mode B reaches it over the private network with no tunnel.

Details in [`skill/agent-face/references/deploy.md`](skill/agent-face/references/deploy.md).

---

## Install the skill

The `skill/agent-face/` folder is a **portable Agent Skill** (open [Agent Skills](https://agentskills.io) standard) — harness-agnostic `node`/`bash` scripts, no Claude-specific tooling. It works on **Claude Code, Hermes, openclaw, trustclaw, nanoclaw**. Drop it into your harness's skills directory; the skill drives:

| Script | Purpose |
|---|---|
| `scripts/scaffold.mjs` | Copy the app template into a target dir |
| `scripts/dev.mjs` | Free the dev port (kills only this app's own previous server; foreign holders refused unless `--take-port`), start dev, open the browser |
| `scripts/check-env.mjs` | Report which brains/STT/TTS are configured (secrets masked) |
| `scripts/deploy.mjs` | Deploy to Vercel or build the self-host image |

Portability matrix: [`skill/agent-face/references/portability.md`](skill/agent-face/references/portability.md).

---

## Environment variables (all optional)

| Var | Unlocks |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) chat brain |
| `OPENROUTER_API_KEY` | OpenRouter chat brain (Hermes + hundreds of models) |
| `GROQ_API_KEY` | Groq chat brain + fast hosted Whisper STT |
| `OPENAI_API_KEY` | Hosted Whisper STT + `gpt-4o-mini-tts` voice-out |
| `AGENT_BRIDGE_KIND` / `AGENT_BRIDGE_URL` / `AGENT_BRIDGE_KEY` | Mode B: wire the face to your running agent |
| `HERMES_API_BASE_URL` / `HERMES_API_KEY` | Mode B convenience for a Hermes `api_server` |

All keys are **server-side only** (never `NEXT_PUBLIC_*`). Missing keys degrade gracefully. Full list in [`.env.example`](.env.example).

---

## Architecture

```
Browser (Next.js on Vercel CDN, or self-hosted next to your agent)
  mic → Whisper (browser WebGPU / hosted) → /api/chat (your brain) → TTS → wawa-lipsync → 12-emotion face
                                             ↑ keys + provider fan-out live server-side (thin, ~free)
```

Deep dive: [`skill/agent-face/references/architecture.md`](skill/agent-face/references/architecture.md).

![Talking](public/screenshots/talking.png)

---

## Status

This repo currently ships the **build plan** — [`prd.json`](prd.json), a 58-task requisites list (frontend, backend, skill, docs, infra) that drives building the app. Contributions welcome once scaffolding lands; see [`CONTRIBUTING.md`](CONTRIBUTING.md) (and [`docs/development.md`](docs/development.md) for the repo layout).

## License

MIT
