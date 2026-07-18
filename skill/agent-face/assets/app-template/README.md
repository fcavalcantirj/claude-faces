# Agent Face — app template

This directory is a **self-contained, deployable snapshot** of the Agent Face
web app, packaged inside the `agent-face` skill. It is what
`scripts/scaffold.mjs` copies into a target directory.

> **Do not edit files here by hand.** The repo-root app is the single source of
> truth; this template is regenerated from it by
> `skill/agent-face/scripts/sync-template.mjs`. Run that script (or
> `--check` in CI) to keep the two in lock-step.

## Run it

```bash
cp .env.example .env.local     # add >=1 provider key, or wire your running agent (both optional)
npm install
npm run dev                    # http://localhost:3000, then press "talk"
```

With **zero keys** it still runs: speech-to-text uses in-browser Whisper
(WebGPU, private, offline) and speech-out uses the browser Web Speech API. Add a
key or wire a local agent to unlock hosted models and higher-fidelity lip-sync.

## Deploy

```bash
npm run build && npm start                 # self-host (Node)
docker compose up --build                  # self-host (Docker, next to your agent)
```

or push to Vercel. See the skill references for the full contract:

- `references/backends.md` — wiring a brain (Mode A keys or a Mode B running agent) + every env name
- `references/architecture.md` — the mic -> STT -> /api/chat -> TTS -> lip-sync -> face pipeline
- `references/deploy.md` — deploying to Vercel or self-hosting with Docker
- `references/portability.md` — running the skill on a non-Claude harness

All provider keys are **server-side only** (never `NEXT_PUBLIC_*`) and optional;
missing keys degrade gracefully.
