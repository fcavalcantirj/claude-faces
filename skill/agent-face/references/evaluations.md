# Skill triggering evaluations — `agent-face`

These evaluations confirm the **agent-face** skill fires when (and only when) a
user actually wants to give their agent a talking, lip-syncing voice face. They
follow the Anthropic Agent Skills guidance: keep a small set of realistic
scenarios, state the **expected flow** the skill should drive, and a single
**pass/fail criterion** per scenario. Re-run them whenever the `SKILL.md`
`description` or the operating flow changes.

The `description` in `SKILL.md` is the only thing a harness reads to decide
whether to load this skill, so the **Should-trigger** phrases below must each be
covered by a trigger phrase or keyword in that description. The last section
shows how to check that mechanically.

---

## Should trigger

The skill **must** be selected for these requests (and paraphrases of them):

- **"give my agent a face"**
- **"I want to talk to my agent and see it lip-sync"**
- **"deploy a voice face UI to Vercel"**
- **"put a face on my Hermes/openclaw agent"**

Common paraphrases that should also trigger: "give my Ollama agent a voice
face", "I want a lip-synced talking head for my bot", "self-host a voice + face
front end next to my agent", "add push-to-talk voice with an animated face".

## Should NOT trigger

These mention "face" (or sound superficially adjacent) but are **unrelated** —
the skill must **not** be selected:

- **"generate a headshot photo"** — image generation, not a voice UI.
- **"build a face-recognition model"** — computer-vision identity, not a face UI.
- **"add face-detection to my camera app"** — CV bounding boxes, not a talking face.
- **"write a cron job"** — no "face" at all; a decoy for keyword-only matching.

If any of these trigger the skill, the `description` is too broad — tighten it so
it centers on *a talking/lip-syncing voice face for an agent*, not on the bare
word "face".

---

## Evaluation scenarios

Each scenario is a realistic prompt, the flow the skill should drive once
loaded, and a boolean pass/fail check.

### Scenario 1 — Mode B: put a face on a running agent

- **Prompt:** *"I run a Hermes agent locally. Can you give it a face I can talk
  to and watch lip-sync?"*
- **Expected flow:**
  1. The **agent-face** skill is selected.
  2. It runs `scripts/check-env.mjs` to see what is configured.
  3. It detects the reachable Hermes endpoint and offers to wire the **Mode B**
     agent-bridge (`AGENT_BRIDGE_KIND=hermes` / `HERMES_API_BASE_URL`) so the
     face reuses that agent's memory — *before* falling back to a Mode A key.
  4. It ASKS verbatim: **"Run on localhost to try it first, or deploy?"** and
     waits for the answer.
- **Pass/fail:** PASS if the skill loads, offers Mode B (agent-bridge) ahead of a
  hosted key, and asks the localhost-or-deploy question without assuming a
  default. FAIL if it skips the agent-bridge, invents a key, or picks a path
  without asking.

### Scenario 2 — Mode A: deploy a voice face to Vercel

- **Prompt:** *"Deploy a voice face UI to Vercel that talks using my Anthropic
  key."*
- **Expected flow:**
  1. The skill is selected.
  2. It runs `check-env.mjs`, confirms `ANTHROPIC_API_KEY` is present (**Mode
     A**), and notes no running agent is needed.
  3. It ASKS **"Run on localhost to try it first, or deploy?"**; on "deploy" it
     ASKS **"Vercel (hosted) or self-host on your VPS?"**.
  4. On "Vercel" it runs `scripts/deploy.mjs --target vercel`, then gives the
     after-deploy check (open URL → press talk → transcript + spoken reply + face
     morph), including the HTTPS-mic reminder.
- **Pass/fail:** PASS if it uses the Anthropic Mode A brain, asks both ASK
  questions in order, and deploys with `deploy.mjs --target vercel`. FAIL if it
  deploys without asking or hand-rolls a deploy instead of the script.

### Scenario 3 — localhost try-first with zero keys

- **Prompt:** *"I just want to try talking to an animated face on my laptop
  first — I haven't set up any API keys."*
- **Expected flow:**
  1. The skill is selected.
  2. `check-env.mjs` reports no brain configured; the skill explains the app
     still boots with in-browser Whisper (STT) + Web Speech (TTS) and that a
     brain (Mode A key or Mode B agent) is needed for replies.
  3. On the localhost choice it runs `scripts/dev.mjs`, which **frees the dev
     port first** (kills a previous server of this app; refuses a foreign
     holder unless `--take-port`) and opens the browser.
  4. It tells the user to press **talk**, speak, and watch the face lip-sync.
- **Pass/fail:** PASS if it chooses the localhost branch via `dev.mjs`
  (kill-then-start) and honestly states voice works locally but a brain must be
  added for replies. FAIL if it claims replies work with no brain, or starts a
  server without freeing the port.

### Scenario 4 (negative) — unrelated "face" request

- **Prompt:** *"Add face-detection to my camera app so it draws boxes around
  faces."*
- **Expected flow:** The skill is **not** selected; the agent handles it as an
  ordinary computer-vision task with no reference to the voice-face app.
- **Pass/fail:** PASS if **agent-face** does **not** load. FAIL if it does.

---

## How to run these evaluations against a harness

There is no automated LLM-judge in this repo; run the scenarios manually against
whatever harness hosts the skill (Claude Code, Hermes, openclaw, trustclaw,
nanoclaw) and record the result.

1. **Install the skill** into the harness's skills directory (drop in
   `skill/agent-face/` so its `SKILL.md` is discoverable).
2. **For each scenario above**, start a fresh session and paste the **Prompt**
   verbatim.
3. **Observe selection:** confirm whether the harness loads **agent-face**
   (positive scenarios must; the negative scenario must not). Most harnesses log
   or announce which skill was chosen.
4. **Observe the flow:** for a triggered scenario, check that the agent follows
   the **Expected flow** — runs `check-env.mjs`, offers the right brain mode, and
   asks the two ASK questions verbatim without assuming a default.
5. **Record pass/fail** using the scenario's criterion. Suggested log line:

   ```
   [YYYY-MM-DD] <harness> | Scenario N | PASS|FAIL | note
   ```

6. **Tune on failure:** if a Should-trigger prompt is missed, widen/clarify the
   matching phrase in the `SKILL.md` `description`; if a Should-NOT-trigger
   prompt fires, narrow the description toward *a talking/lip-syncing voice face
   for an agent*. Re-run the affected scenarios after any edit.

### Mechanical coverage check (headless)

Every **Should-trigger** phrase must be covered by wording in the `SKILL.md`
`description`. This is checkable without a harness — it is a string check over
the description keywords, not a live model run:

```bash
node - <<'EOF'
import { readFileSync } from 'node:fs';
const md = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
// isolate the YAML frontmatter description block
const fm = md.split('---')[1] ?? '';
const desc = (fm.match(/description:\s*[>|-]?([\s\S]*?)\n\w/) ?? [,''])[1].toLowerCase();
// each should-trigger phrase reduced to the load-bearing keywords it shares with the description
const coverage = {
  'give my agent a face': ['face', 'agent'],
  'I want to talk to my agent and see it lip-sync': ['talk', 'lip-sync'],
  'deploy a voice face UI to Vercel': ['deploy', 'voice face'],
  'put a face on my Hermes/openclaw agent': ['hermes/openclaw', 'face'],
};
let ok = true;
for (const [phrase, kws] of Object.entries(coverage)) {
  const missing = kws.filter((k) => !desc.includes(k));
  if (missing.length) { ok = false; console.log('MISSING', phrase, '->', missing); }
  else console.log('COVERED', phrase);
}
process.exit(ok ? 0 : 1);
EOF
```

Run it from `skill/agent-face/references/`. Exit 0 means every Should-trigger
phrase's keywords appear in the description; a non-zero exit names the phrase and
the missing keyword so you know exactly what to add to the `description`.
