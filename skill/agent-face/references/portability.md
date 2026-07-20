# Portability — running Agent Face on any harness

`skill/agent-face/` is a **portable Agent Skill** built to the open
[Agent Skills](https://agentskills.io) standard. It is deliberately
**harness-agnostic**: everything the skill does is driven by plain **Node ESM**
(and a little bash-free `node:*` I/O) — there is **no Claude-specific tooling, no
MCP calls, and no harness API** anywhere in the scripts. Any agent runtime that
can (a) discover a `SKILL.md` and (b) run `node script.mjs` can use it.

This is what makes the north-star line true: *point the skill at an agent → it
gets a face* — whether that agent is Claude Code, a Hermes `api_server`, or a
self-hosted openclaw/nanoclaw process.

---

## What "portable" means here

| Guarantee | How it's kept |
|---|---|
| **No harness coupling** | The scripts import only `node:*` built-ins (`node:fs`, `node:path`, `node:child_process`, `node:net`, `node:url`, `node:process`). No SDK, no MCP client, no `allowed-tools` / `tool_use` machinery. |
| **No external npm deps to run a script** | `scaffold.mjs`, `dev.mjs`, `check-env.mjs`, and `deploy.mjs` each run under a bare `node` with nothing installed. (The *app they scaffold* has deps; the *skill scripts* do not.) |
| **Open frontmatter subset** | `SKILL.md` frontmatter uses only the portable/open keys `name`, `description`, `version`, `license`. Anything harness- or brand-specific (`brand`, `category`, `package-manager`) lives under `metadata:` so a stricter harness can ignore it safely. |
| **Reserved-name rule** | `name: agent-face` — the skill name contains neither `claude` nor `anthropic` (both reserved). The product brand "Claude Faces" lives only in `metadata.brand`. |
| **Plain-runtime invocation** | Every script supports `--help` and exits 0 under a bare `node`, so a harness can probe it with no arguments and no dependencies. |

> Note on the word "Claude": the skill *mentions* Anthropic/Claude as a **brain
> provider** (the `ANTHROPIC_API_KEY` env var, `claude-*` model ids, and the
> `claude-code` agent-bridge kind) and in portability comments. Those are
> product-domain references, **not** harness coupling — the skill never calls a
> Claude/MCP API to do its own work.

---

## Harness matrix

Every harness uses the **same two primitives**: it discovers `SKILL.md`, then
runs the Node scripts. Nothing below requires a harness-specific adapter.

| Harness | How it discovers the skill | How it invokes the scripts | Notes |
|---|---|---|---|
| **Claude Code** | Drop `agent-face/` into the skills dir (`~/.claude/skills/` or a project `.claude/skills/`); the `SKILL.md` frontmatter (`name`, `description`) drives triggering. | The model runs `node skill/agent-face/scripts/<name>.mjs` via its Bash tool. | Reference harness. No Claude-only frontmatter keys are required. |
| **Hermes** (`api_server`) | Place `agent-face/` in Hermes's skills/tools directory; Hermes reads the same open `SKILL.md`. | Hermes shells out to `node …/<name>.mjs`. | Also a natural **Mode B brain**: wire the agent-bridge back to this same Hermes `api_server` (`AGENT_BRIDGE_KIND=hermes`) so the face reuses the agent's memory. |
| **openclaw** | Add `agent-face/` to openclaw's skill path; standard `SKILL.md` discovery. | `node …/<name>.mjs` from openclaw's shell/exec capability. | Mode B kind `openclaw` bridges the face to a running openclaw agent. |
| **trustclaw** | Same open-standard `SKILL.md` discovery in trustclaw's skills directory. | `node …/<name>.mjs`. | Uses only the portable frontmatter subset, so trustclaw's stricter loader accepts it. |
| **nanoclaw** | Drop-in `SKILL.md`; minimal loader reads `name` + `description` only. | `node …/<name>.mjs`. | The lightest harness — proves the skill needs nothing beyond a `node` runtime. |

If a harness cannot discover `SKILL.md` automatically, a human (or the agent) can
still run any script directly by absolute path — the scripts resolve their
template/app paths relative to their own location, so they work when the skill is
extracted standalone.

---

## The four scripts (all plain `node`)

| Script | One-line purpose | Runs standalone? |
|---|---|---|
| `scripts/scaffold.mjs` | Copy the app template into a target directory | ✅ `node scaffold.mjs ./agent-face-app` |
| `scripts/dev.mjs` | Free the dev port (SIGTERM→SIGKILL a prior server of THIS app; foreign holders are refused unless `--take-port`), start dev, open the browser | ✅ `node dev.mjs [--port N] [--no-open] [--take-port]` |
| `scripts/check-env.mjs` | Report which brains / STT / TTS are configured (secrets masked) | ✅ `node check-env.mjs [--json]` |
| `scripts/deploy.mjs` | Deploy to Vercel or build the self-host image | ✅ `node deploy.mjs --target vercel|self-host` |

Every one accepts `--help` and exits 0 with usage — the portable probe any
harness can run first.

---

## Verifying portability yourself

Two checks, both runnable under a bare `node` with nothing installed.

**1. All four scripts run under a plain runtime** (no missing-dependency errors):

```bash
for s in scaffold dev check-env deploy; do
  node skill/agent-face/scripts/$s.mjs --help >/dev/null && echo "$s: ok"
done
```

**2. The portability grep returns zero *harness-coupled* matches.** The
harness-coupling tokens are MCP / tool-plumbing APIs — never a provider name:

```bash
grep -rniE 'mcp|allowed-tools|tool_use|claude-code-sdk|@anthropic-ai/(sdk|claude)' \
  skill/agent-face/scripts/
# → no output: zero harness-coupled references
```

A broader `grep -riE 'anthropic|claude'` **will** match — but only the
provider-domain references listed above (env var, model ids, the `claude-code`
bridge kind, portability comments). Those are expected and are not coupling.
The skill drives its own work purely with `node:*` built-ins.

---

## Adding a harness

Nothing to add. Because discovery is "read `SKILL.md`" and invocation is "run
`node`", a new harness is supported the moment it can do those two things. If a
harness needs extra metadata, put it under `metadata:` in `SKILL.md` — never in
the top-level portable keys — so every other harness keeps ignoring it.
