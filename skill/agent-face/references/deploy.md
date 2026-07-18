# Deploying claude-faces

Two targets. Pick based on where your brain lives.

| Target | Best when | Mode B (agent-bridge) |
|---|---|---|
| **Vercel** (hosted) | You use a Mode A key (Anthropic / OpenRouter / Groq), or your agent is on a public HTTPS URL | Only via a public HTTPS tunnel |
| **Self-host** (Docker on your VPS) | You want the face **next to an agent you already run** | Reaches the agent over the **private network — no tunnel** |

The skill's `scripts/deploy.mjs --target <vercel|self-host>` wraps both flows; the
sections below document what it does and how to run them by hand.

---

## Self-host (Docker, next to your agent)

This is the reason to self-host: run the face on the **same private network** as
an agent you already run (Hermes `api_server`, openclaw / nanoclaw, a local
Claude Code bridge, or Ollama). Point `AGENT_BRIDGE_URL` at the agent's private
address and Mode B reuses that agent — its memory, tools, and persona — as the
face's brain, with **no public HTTPS tunnel**.

### What ships

- **`Dockerfile`** — multi-stage build (`deps` → `build` → `runner`) around
  Next.js `output: 'standalone'` (set in `next.config.mjs`). The final image is
  just `node server.js` + `public/` + `.next/static`, running as a non-root
  user. `next build` runs the `prebuild` hook (`scripts/setup-vad-assets.mjs`),
  so the hands-free VAD/ONNX assets are baked into `public/vad/`.
- **`docker-compose.yml`** — runs the app, publishes `${PORT:-3000}`, loads all
  config from `.env.local`, and sets `SELF_HOST=1` so the agent-bridge is
  allowed to reach a private-network URL.
- **`.dockerignore`** — keeps `node_modules`, build output, `.env*`, and secrets
  out of the build context and image layers.

### Run it

```bash
cp .env.example .env.local          # fill in AGENT_BRIDGE_* and/or provider keys
docker compose up --build           # serves http://localhost:${PORT:-3000}
```

Or without compose:

```bash
docker build -t claude-faces .
docker run --rm -p 3000:3000 --env-file .env.local claude-faces
```

### Wire Mode B over the private network (no tunnel)

Set these in `.env.local` (all server-side only):

```bash
SELF_HOST=1                         # already forced by docker-compose.yml
AGENT_BRIDGE_KIND=ollama            # hermes | openclaw | claude-code | ollama | openai-compatible
AGENT_BRIDGE_URL=http://ollama:11434
# AGENT_BRIDGE_KEY=...              # if the agent requires auth
```

Reaching the agent from the container:

- **Agent is another service in the same compose file** → reference it by
  service name: `AGENT_BRIDGE_URL=http://ollama:11434`. Uncomment the
  `networks:`/service stub at the bottom of `docker-compose.yml`.
- **Agent runs on the Docker host** → use the host gateway, e.g.
  `AGENT_BRIDGE_URL=http://172.17.0.1:11434` (Linux) or
  `http://host.docker.internal:11434`.
- **Agent is elsewhere on the VPS's private LAN** → use its private IP/hostname.

Because `SELF_HOST=1`, the agent-bridge adapter treats the private URL as
reachable and the brain appears in the settings picker — no `ALLOW_AGENT_BRIDGE_IN_PROD`
and no public tunnel required. (On Vercel the same private URL would be hidden.)

### HTTPS / microphone reminder

The mic (`getUserMedia`) and browser-Whisper (`crossOriginIsolated`) paths need a
**secure context**: `http://localhost` works, but any other host must be served
over **HTTPS**. Put the container behind a reverse proxy (Caddy, nginx, Traefik)
that terminates TLS when you expose it beyond localhost.

---

## Vercel (hosted)

Click the **Deploy with Vercel** button in the repo `README.md`, or:

```bash
node skill/agent-face/scripts/deploy.mjs --target vercel --prod
```

`next.config.mjs`'s `output: 'standalone'` is ignored by Vercel's own build
pipeline. All four provider keys are optional and prompted at clone time; with
none set the app still runs on browser-Whisper STT + Web Speech TTS. Mode B works
on Vercel **only** when `AGENT_BRIDGE_URL` is a public HTTPS/tunnel URL (or
`ALLOW_AGENT_BRIDGE_IN_PROD=1`) — a serverless function can't reach your private
localhost.

After deploy: open the URL, press **talk**, and confirm you get a live
transcript, a spoken reply, and the face morphing between emotions.
