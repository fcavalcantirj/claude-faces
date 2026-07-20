# Troubleshooting claude-faces

Symptom → cause → a concrete check you can run. The face itself is **never
gated** — if the particles render, the app booted; everything below is about the
voice, chat, and emotion paths layered on top.

Fastest first move: **`node skill/agent-face/scripts/check-env.mjs`** (from the
app dir) prints which brains / STT / TTS are wired, masks every secret, and exits
non-zero when no chat brain is usable. Add `--probe` to live-test an
agent-bridge URL. Most "nothing answers" reports are a missing key it will spot
in one line.

---

## 1. Browser cannot record (HTTPS / MediaRecorder)

**Symptom:** pressing *talk* does nothing, the mic permission prompt never
appears, or the console shows `getUserMedia` / `NotAllowedError` /
`MediaRecorder is not defined`.

**Cause:** `getUserMedia` only works in a **secure context**. `http://localhost`
counts as secure, but any other host served over plain `http://` does not — the
browser silently withholds the microphone.

**Check:**

```js
// in the browser devtools console, on the app origin
window.isSecureContext          // must be true
navigator.mediaDevices          // must be defined (undefined ⇒ insecure origin)
```

If `isSecureContext` is `false`, you are on a non-localhost host over HTTP. Serve
the app over **HTTPS** — on Vercel the `*.vercel.app` URL is already HTTPS; for
self-host put the container behind a TLS-terminating reverse proxy (Caddy /
nginx / Traefik), see [`deploy.md`](deploy.md). Also confirm the site's mic
permission isn't set to **Block** in the address-bar site settings.

---

## 2. Transcription fails (keys / size / model)

**Symptom:** speech is captured but no transcript appears, or the hosted STT
fallback returns an error.

**Causes & checks:**

- **In-browser Whisper never loads** — needs cross-origin isolation and a
  one-time model download. See **§6** below (`self.crossOriginIsolated`) and
  confirm the Hugging Face model fetch isn't blocked by an offline network.
- **Hosted fallback has no key** — the `/api/transcribe` route uses Groq
  `whisper-large-v3-turbo` when `GROQ_API_KEY` is set, else OpenAI
  (`whisper-1` / `gpt-4o-transcribe`) when `OPENAI_API_KEY` is set. With neither,
  the client falls back to in-browser Whisper only.

  ```bash
  node skill/agent-face/scripts/check-env.mjs   # STT row shows groq / openai ✓/✗
  ```
- **Clip too large** — a very long recording can exceed the serverless request
  body cap (Vercel is ~4.5 MB) or the provider's audio limit. Keep utterances
  short (push-to-talk), or prefer the in-browser path which never uploads.
- **Wrong model override** — an invalid `OPENAI_TRANSCRIBE_MODEL` yields a
  provider 400/404. Unset it to use the default `whisper-1`.

---

## 3. Chat brain fails (key / auth / rate limit / agent offline)

**Symptom:** you speak, the face goes *thinking*, then nothing is spoken — or a
`glitch` face and an error notice appear.

**Check — which brain, and is it wired:**

```bash
node skill/agent-face/scripts/check-env.mjs      # shows the resolved default brain
curl -s http://localhost:3000/api/config | node -e \
  'process.stdin.on("data",d=>console.log(JSON.stringify(JSON.parse(d),null,2)))'
```

`/api/config` returns a secret-free capability map (`providers`, `agentBridge`,
`defaultProvider`). Map the error by its code:

- **`unavailable`** — the selected provider has no key/endpoint. Add the key
  (`ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `GROQ_API_KEY`) or pick a
  provider that is available in **Settings**.
- **`unauthorized` (401/403)** — the key is present but wrong/revoked. Regenerate
  it; keys are server-side only, so update the deployment env, not the client.
- **`rate_limited` (429)** — you hit the provider's quota. Wait, switch provider,
  or upgrade the plan.
- **`network` / "agent offline"** — a **Mode B** agent-bridge could not be
  reached. Confirm the agent is running and the URL is right:

  ```bash
  node skill/agent-face/scripts/check-env.mjs --probe   # live-probes AGENT_BRIDGE_URL
  ```

  On **Vercel** a private/localhost `AGENT_BRIDGE_URL` is intentionally hidden —
  a serverless function can't reach your LAN. Use a public HTTPS tunnel or set
  `ALLOW_AGENT_BRIDGE_IN_PROD=1`; self-host reaches it over the private network
  directly. See [`backends.md`](backends.md).

---

## 4. Face does not change emotion (invalid directive ignored)

**Symptom:** the reply is spoken but the face stays `neutral` / never reacts,
or a literal `[[face:...]]` string is spoken aloud.

**Cause:** the model steers expression by emitting a directive of the exact form
`[[face:<emotion>]]` (or `[[emotion:<emotion>]]`). The emotion machine **strips
every such token before TTS** and applies the **last valid** one. A directive
whose word isn't one of the 12 emotions is stripped but **ignored** (no throw) —
so a typo like `[[face:banana]]` silently does nothing, and the lifecycle
fallback (`speaking` → resting-by-sentiment) stands instead.

**Check** the emotion word is spelled as one of the 12:

```
neutral thinking speaking happy alert sad angry surprised confused sleepy love glitch
```

- Directive spoken aloud instead of stripped → the token was malformed (e.g.
  single brackets `[face:happy]`); only the double-bracket form is parsed.
- Face never reacts at all → the model isn't emitting directives; the persona
  system prompt teaches them, so confirm your custom `system` override still
  includes the emotion vocabulary (see `lib/persona.ts`).

The face also changes on its own across the conversation lifecycle
(`thinking`/`speaking`/`glitch` on error) regardless of directives — if *that*
never happens, the problem is chat (§3), not emotions.

---

## 5. Dev server port already in use

**Symptom:** `npm run dev` exits with `EADDRINUSE` / `port 3000 is already in
use`, or a stale server from a prior run answers.

**Cause:** a previous `next dev` is still holding the port.

**Fix:** always start via the skill's dev script — it **frees the port first**
(SIGTERM, then SIGKILL any survivor) before spawning. It is scoped to that one
port AND to this app's own processes: a holder it can't tie to this app (by
working directory / command line) is refused with exit 3 and its identity, so
it never kills an unrelated project's server:

```bash
node skill/agent-face/scripts/dev.mjs                 # free :3000, start, open browser
node skill/agent-face/scripts/dev.mjs --port 4000     # use a different port
node skill/agent-face/scripts/dev.mjs --kill-only     # just free the port, don't start
node skill/agent-face/scripts/dev.mjs --take-port     # kill even a foreign holder
```

**Check** what holds the port manually (macOS/Linux):

```bash
lsof -ti tcp:3000        # prints the PID(s) bound to :3000; empty ⇒ free
```

---

## 6. Cross-origin not isolated (browser Whisper won't run)

**Symptom:** in-browser Whisper (transformers.js / WebGPU) fails to start,
`SharedArrayBuffer is not defined`, or a WASM thread-pool error in the console.

**Cause:** the multi-threaded WASM / WebGPU backend needs
`self.crossOriginIsolated === true`, which requires the COOP + COEP response
headers. The app sets them site-wide in `next.config.mjs`
(`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: credentialless`).

**Check:**

```js
// browser devtools console, on the app origin
self.crossOriginIsolated         // must be true
```

```bash
# confirm the headers actually ship (adjust host for your deploy)
curl -sI http://localhost:3000/ | grep -iE 'cross-origin-(opener|embedder)-policy'
```

If `crossOriginIsolated` is `false`: a **reverse proxy or CDN stripped the
headers** — re-add them at the proxy, or make sure you didn't override
`next.config.mjs`. If a specific cross-origin embed/asset breaks under
`credentialless`, that's the documented escape hatch (switch to `require-corp`
only if you also serve every subresource with a CORP header). The hosted STT
fallback (§2) works without isolation, so the app still transcribes via Groq /
OpenAI while you fix this.

---

## 7. `next build` crashes with `useContext` null (`NODE_ENV`)

**Symptom:** `npm run typecheck` passes but `next build` fails while prerendering
an *internal* page — `/_global-error`, `/_not-found`, or `/404` (the exact page
**moves between runs**) — with `Cannot read properties of null (reading
'useContext')`, often alongside React `unique "key"` warnings on
`<html>`/`<head>`/`<meta>` during what is supposed to be a production build.

**Cause:** the environment forces **`NODE_ENV=development`** — most often an
`export NODE_ENV=development` left in a shell rc (e.g. `~/.zshrc`). `next build`
requires `NODE_ENV=production`; pinned to development, React loads its **dev**
build for part of the module graph and its **prod** build for the rest, so the
SSR dispatcher is `null` and the first prerendered page throws. The surviving
dev-only key warnings are the tell — a genuine production build strips them.
This is **environmental, not a code or framework/version bug**: a clean env (and
Vercel) builds fine, so do **not** downgrade Next or pin React chasing it.

**Check:**

```bash
echo "$NODE_ENV"                    # must be empty or "production" to build
NODE_ENV=production npm run build   # exits 0 if NODE_ENV was the cause
```

If `echo $NODE_ENV` prints `development`, remove or scope the `export
NODE_ENV=...` in your shell rc (it silently breaks other tools' production
builds too), open a fresh shell, and rebuild.

---

## Nothing configured (the degradation messages)

With **zero** provider keys and no agent-bridge, the app still boots — the face
renders and animates. What you'll see, and why:

- **A `NO BRAIN` banner:** *"No brain configured. Add a key on the server
  (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or `GROQ_API_KEY`) or wire your
  running agent (`AGENT_BRIDGE_URL`), then reload."* — chat is off until a brain
  is reachable; the face and browsing still work.
- **Settings says** *"No chat brain is configured. Set a provider key…"* — same
  cause, shown where you pick a brain.
- **Voice-in still works** via in-browser Whisper (no key needed); hosted STT is
  simply absent (*"Set `GROQ_API_KEY` or `OPENAI_API_KEY`, or use in-browser
  Whisper."*).
- **Voice-out still works** via the browser Web Speech API; hosted TTS is absent
  (*"Set `OPENAI_API_KEY`, or use the browser Web Speech API."*).

This is **graceful degradation, not an error** — nothing here is a bug. To turn
chat on, add one key and reload:

```bash
node skill/agent-face/scripts/check-env.mjs   # confirms a brain is now usable (exit 0)
```

See [`backends.md`](backends.md) for every brain option and
[`../../../docs/env-contract.md`](../../../docs/env-contract.md) for the full
variable list.

---

## Running the scripts under a non-Claude harness

The skill's scripts are **plain Node ESM + bash** — no Claude-specific tooling,
no external deps. Any harness (Hermes, openclaw, trustclaw, nanoclaw) or a bare
shell runs them the same way, by path:

```bash
node skill/agent-face/scripts/check-env.mjs    # report configured brains/STT/TTS
node skill/agent-face/scripts/scaffold.mjs      # copy the app template into a target dir
node skill/agent-face/scripts/dev.mjs           # free the port, start dev, open browser
node skill/agent-face/scripts/deploy.mjs --target vercel   # or --target self-host
```

Requirements: **Node 22+** and `npm` on `PATH`. Port-freeing in `dev.mjs`
finds the holder via `lsof`, `/proc`, `ss`/`fuser`, or `netstat` and
identifies it via `ps`+`lsof` (macOS/Linux, `/proc` in bare containers) or
PowerShell/CIM (Windows). A holder that can't be tied to this app is refused
with **exit 3** — pass `--take-port` to kill it anyway. If your harness passes
a working directory that isn't the app root, `cd`
into the scaffolded app first (the scripts resolve the app dir from the current
directory, falling back to the packaged `assets/app-template`). Full harness
matrix: [`portability.md`](portability.md).
