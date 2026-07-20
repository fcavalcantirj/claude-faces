# Product Hunt launch kit — Agent Faces

Everything needed to submit and run the launch day. Assets live in
[`gallery/`](gallery/) (1270×760, captured from the live app) plus
[`thumbnail-240.png`](thumbnail-240.png) and the repo's `public/og.png` (1200×630).

## Listing

**Name:** Agent Faces

**Tagline (≤60 chars) — options, first is the pick:**
1. `Give your AI agent a talking, lip-syncing face` (46)
2. `Talk to your AI agent, face to face` (35)
3. `Your agent, now with a voice, a face, and 12 moods` (50)

**Description (~260 chars):**
> Agent Faces turns any AI agent into someone you talk to. Speak, and a 4,700-particle
> face answers out loud — real audio lip-sync, 12 self-steered emotions. Zero keys needed
> (in-browser Whisper + Web Speech), or bring the agent you already run. Open source, MIT.

**Topics:** Artificial Intelligence · Open Source · Developer Tools · Voice/Audio

**Links:** GitHub repo (primary). Add the Vercel demo URL here if one is deployed before
launch day.

## Maker's first comment (draft — personalize before posting)

> Hey Product Hunt 👋
>
> Agent Faces started from one itch: my coding agent already had memory, tools, and a
> personality — but talking to it meant reading a terminal. I wanted to *talk* to it and
> have it talk back. With a face.
>
> So: you speak → Whisper (running **in your browser**, on WebGPU — private, offline, $0)
> transcribes → your agent replies → the reply is spoken and drives ~4,700 particles that
> lip-sync to the actual audio. The model steers its own expression mid-sentence with
> `[[face:happy]]`-style directives. 12 emotions, including a glitch mode I'm unreasonably
> fond of.
>
> Two things make it different:
> 1. **Bring your own agent.** Mode B attaches the face to an agent you ALREADY run
>    (Claude Code, Hermes, openclaw, Ollama) — its memory, its tools, its persona. Not a
>    stateless chat completion wearing a mask.
> 2. **The repo built itself.** Most of the codebase was written overnight by a loop of
>    autonomous coding-agent runs; the task ledger and the agents' journal are still in the
>    repo. The face you're talking to helped build its own face.
>
> Zero keys gets you a working face. MIT licensed. Would love to hear what agent you'd
> put a face on. 🗣️😃

## Gallery order

1. `gallery/01-hero-neutral.png` — the four-corner UI, READY state
2. `gallery/02-speaking.png` — mouth open, SPEAKING readout
3. `gallery/03-love.png` — heart-eyes, pink particles ("BOND PROTOCOL // AFFINITY MAX")
4. `gallery/04-glitch.png` — glitch mode
5. `gallery/05-pi-arm64-modeb.png` — captured by an autonomous agent that installed the
   skill on its own Raspberry Pi (arm64) and wired Mode B; a real reply is visible in the
   transcript. Caption honestly: "installed and wired by an AI agent on a Raspberry Pi."
6. `public/screenshots/demo.gif` — motion (upload as the animated slot)

## Launch-day checklist

- [ ] Schedule for 12:01 AM PT (Product Hunt's day resets then; full 24h of exposure)
- [ ] Upload thumbnail (`thumbnail-240.png`), gallery in the order above, demo.gif as the animation
- [ ] Set topics; link the GitHub repo
- [ ] Post the maker comment IMMEDIATELY after going live (personalized)
- [ ] GitHub side, same morning:
  - [ ] Repo social-preview image → upload `public/og.png` (Settings → General → Social preview — UI-only, no API)
  - [ ] Pin the repo on the profile
  - [ ] Confirm description + topics look right on the repo page
- [ ] Reply to every PH comment same-day (comment velocity feeds ranking)
- [ ] Cross-post: X/Twitter thread (demo.gif first), HN Show HN (`Show HN: Agent Faces — give your AI agent a talking, lip-syncing face`), r/LocalLLaMA (lead with the zero-key/offline Whisper + Ollama angle), lobste.rs
- [ ] GitHub trending ("repository of the day") runs on star velocity in ~24h — concentrate all channels on the same day rather than dripping

## Positioning cheat-sheet (for comments)

- vs. avatar SaaS (HeyGen/D-ID etc.): open source, runs local, zero keys, no per-minute billing — and it fronts YOUR agent, not a hosted persona.
- vs. voice-mode chat apps: the brain is pluggable — the same face works for a raw API key or the long-lived agent you already run.
- Privacy angle: STT can run fully in-browser on WebGPU; nothing leaves the machine in zero-key mode.
- The meta angle: built by an autonomous agent loop; `prd.json` + `progress.txt` are the receipts.
