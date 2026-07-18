# CLAUDE.md — claude-faces

Guidelines for any agent (human or Ralph loop) building **claude-faces**. This file is
injected into every Ralph iteration alongside `README.md`, `prd.json`, and `progress.txt`.

## What this project is

**Claude Faces** gives an AI agent a talking, animated, lip-syncing **face**. You speak →
[OpenAI Whisper](https://github.com/openai/whisper) transcribes → a pluggable **brain**
replies → the reply is spoken back and drives a 12-emotion particle face. It ships as a
**portable Agent Skill** (`skill/agent-face/`) + a **Next.js web app**, runnable on localhost
and deployable to **Vercel or self-host**. Full vision + architecture: **`README.md`**.

Two brain modes behind one `/api/chat` seam:
- **Mode A — fresh API:** Anthropic, OpenRouter (→ Hermes + many), Groq (fast).
- **Mode B — bring-your-own running agent:** an agent-bridge to Hermes `api_server`,
  openclaw/nanoclaw, a local Claude Code bridge, or Ollama — reusing that agent's memory/tools.

Face = the reused **EIDOLON** particle renderer (12 emotions) with real audio-driven lip-sync
(`wawa-lipsync`). Voice = browser Whisper (WebGPU) + hosted fallback; Web Speech / OpenAI TTS.

## Golden rules (MUST follow)

- **Build the real thing** — no mocks, no stubs, no placeholders for real logic.
- **TDD where there's a runtime surface** — write a failing test first, then implement
  (RED → GREEN → REFACTOR). Docs/infra tasks may have no test; use judgment.
- **Keep files focused** — ~500 lines max; split if larger. `SKILL.md` **must** stay ≤ 500 lines.
- **Secrets are server-side only** — never `NEXT_PUBLIC_*`; all provider keys live in route handlers.
- **Reuse, don't reinvent** — port from the READ-ONLY reference at **`../fuguFaces`**.
  **NEVER modify anything under `../fuguFaces`** — copy out only.
- **Match the stack** — Next.js 16 (App Router), React 19, TypeScript, **npm**. Kill any
  previous dev server before starting a new one.
- **Frontmatter name rule** — the skill's `SKILL.md` `name:` must NOT contain `claude` or
  `anthropic` (reserved). Use `name: agent-face`. The repo/brand is still "Claude Faces".

## The task ledger — `prd.json`

`prd.json` is a **bare JSON array**; each task is `{category, description, steps[], passes}`:
- `category` ∈ `backend | frontend | docs | skill | infra`.
- `description` — one-line title; a `🚨 URGENT:` prefix means do it first.
- `steps` — imperative checklist; the LAST steps are `Verify:` lines (how to prove it works).
  Dependencies appear as prose: `DEPENDS ON:` / `PREREQUISITE:`.
- `passes` — `false` until done; flip to `true` when the task's `Verify:` steps pass.

Work top-to-bottom (order encodes priority and satisfies dependencies), one task per run.

## The Ralph build loop

`prd.json` is built autonomously by the Ralph loop. Each iteration does exactly one task
(TDD-first), runs that task's own `Verify:` steps, flips `passes:true`, journals to
`progress.txt`, commits, and (by default) pushes — then STOPS.

```bash
./progress.sh              # 0/58 (0%) → 58/58 (100%)
./ralph.sh 1               # do one task
./ralph.sh 5               # do up to five
./ralph-continuous.sh      # batches of 3, pauses, backoff, Telegram — until 100% or Ctrl+C
```

Env toggles: `PRD_FILE` (default `prd.json`), `RALPH_PUSH=0` (commit only, no push),
`MODEL=<id>` (pin a model), `BATCH_SIZE`, `BATCH_PAUSE_MINS`, `WAIT_TIME_MINS`,
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`.

**Safety:** Ralph runs Claude Code with `--dangerously-skip-permissions` and, by default,
auto-`git push` on every task to a public repo. Use `RALPH_PUSH=0`, a branch, or a private
mirror if you don't want unattended public pushes. Cost/context is reported, not capped.
