# Contributing to Claude Faces

Thanks for helping build **Claude Faces** — a portable Agent Skill + Next.js web app that
gives an AI agent a talking, lip-syncing face. This guide covers local setup, the scripts,
the code-style bar, and the one rule that trips people up most: **keep the packaged skill
template in sync with the app**.

New to the layout? Read [`docs/development.md`](docs/development.md) first — it maps the repo
and draws the boundary between *scaffolding* work (the skill) and *app-internals* work.

---

## Local setup

Requirements: **Node 22** (pinned in [`.nvmrc`](.nvmrc); Next.js 16 needs it) and **npm**
(the canonical package manager — see [`docs/decisions.md`](docs/decisions.md)).

```bash
git clone https://github.com/fcavalcantirj/claude-faces.git
cd claude-faces
nvm use                       # or otherwise ensure Node 22
npm install
cp .env.example .env.local    # optional — add ≥1 provider key, or run keyless
npm run dev                   # http://localhost:3000
```

With **zero keys** the app still boots: STT falls back to in-browser Whisper (WebGPU/WASM) and
TTS to the Web Speech API. Add a key to unlock hosted brains and higher-fidelity lip-sync. All
provider keys are **server-side only** — never `NEXT_PUBLIC_*`. See
[`docs/env-contract.md`](docs/env-contract.md) for the full env contract.

---

## Scripts

App scripts (repo root):

| Command | What it does |
|---|---|
| **`npm run verify`** | **Run every gate — this is what CI runs. Use it before every PR.** |
| `npm run verify -- --e2e` | Same, plus the Playwright browser suite (slower) |
| `npm run verify:linux` | Run the gates in a clean Linux container (needs Docker, no CI account). Catches platform bugs a single OS hides. |
| `npm run verify -- --list` | Show the gates without running them |
| `npm run dev` | Start the Next.js dev server on port 3000 |
| `npm run build` | Production build (`next build`) |
| `npm start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` (also covered by `npm run verify`) |
| `npm run lint` | `eslint .` |
| `npm test` | Vitest unit/integration suite (`vitest run`) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:skill` | Skill script smoke tests (scaffold/dev/check-env/deploy under plain node) |

Portable **skill scripts** (harness-agnostic Node ESM, no Claude-specific tooling — runnable
under any harness with plain `node`):

| Script | Purpose |
|---|---|
| `node skill/agent-face/scripts/scaffold.mjs [dir]` | Copy the app template into a target dir |
| `node skill/agent-face/scripts/dev.mjs` | Free the dev port (kills only this app's own previous server; `--take-port` for foreign holders), then start dev + open the browser |
| `node skill/agent-face/scripts/check-env.mjs` | Report which brains/STT/TTS are configured (secrets masked) |
| `node skill/agent-face/scripts/deploy.mjs --target vercel\|self-host` | Deploy to Vercel or build the self-host image |
| `node skill/agent-face/scripts/sync-template.mjs [--check]` | Regenerate (or verify parity of) the packaged app template |

Each skill script supports `--help`. To test them locally under a plain runtime, run
`node skill/agent-face/scripts/<name>.mjs --help` — they must not depend on any harness API or
MCP tool. `npm run test:skill` exercises them end-to-end.

---

## Code style

- **TypeScript, strict.** `npm run typecheck` and `npm run lint` must be clean before you open
  a PR.
- **TDD where there's a runtime surface** — write a failing test first, then implement
  (RED → GREEN → REFACTOR). Docs/infra changes may have no test.
- **Keep files focused** — ~500 lines max; split if larger. `skill/agent-face/SKILL.md` **must**
  stay ≤ 500 lines.
- **Secrets are server-side only** — provider keys live in route handlers, never `NEXT_PUBLIC_*`.
- **Reuse, don't reinvent** — the EIDOLON particle-face source is vendored at
  `reference/fugu-face/`; port from there rather than rewriting.
- **Frontmatter name rule** — `SKILL.md`'s `name:` must not contain `claude` or `anthropic`
  (reserved). Use `name: agent-face`. The repo/brand is still "Claude Faces".

---

## Single source of truth: sync the app template

The **repo-root app** (`app/`, `components/`, `lib/`, `public/`, `scripts/`, plus the config
files) is **canonical**. `skill/agent-face/assets/app-template/` is a *synced snapshot* of it so
the skill can be extracted standalone and still scaffold a working app.

**If you change any app file that the template mirrors, you MUST re-sync the template in the same
change:**

```bash
node skill/agent-face/scripts/sync-template.mjs          # regenerate the template
node skill/agent-face/scripts/sync-template.mjs --check   # verify parity (exits 1 on drift)
```

CI runs the `--check` (parity) mode and **fails on any divergence**, so an unsynced template
blocks the merge. Never edit `assets/app-template/` by hand — edit the root app, then re-run
`sync-template.mjs`.

---

## Branch & PR workflow

1. Branch off `main` (`git checkout -b your-feature`).
2. Make the change; add/adjust tests (TDD).
3. Run the full local gate before pushing:
   ```bash
   npm run typecheck
   npm run lint
   npm test
   node skill/agent-face/scripts/sync-template.mjs --check
   npm run test:skill
   ```
4. Open a PR against `main` with a clear description.
5. **CI must pass.** The GitHub Actions workflow runs these checks by name, and all are required:
   - **typecheck** — `npm run typecheck`
   - **build** — `npm run build`
   - **skill-lint** — asserts `SKILL.md` frontmatter `name` has no `claude`/`anthropic` and the
     description is non-empty
   - **template parity** — `node skill/agent-face/scripts/sync-template.mjs --check`
   - **portability** — greps `skill/agent-face/scripts` for harness-coupled references and fails
     on any match
   - **test:skill** — `npm run test:skill`

A PR that fails any of these will not be merged. Run the same commands locally first to keep the
loop fast.

---

## License

By contributing you agree your contributions are licensed under the project's [MIT](LICENSE)
license.
