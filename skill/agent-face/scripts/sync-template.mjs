#!/usr/bin/env node
// sync-template.mjs — keep the packaged app template in lock-step with the app.
//
// SINGLE SOURCE OF TRUTH: the repo-root app (app/, components/, lib/, public/,
// scripts/, plus the config files) is canonical. This script regenerates
// skill/agent-face/assets/app-template/ as a self-contained, deployable snapshot
// of it, so the skill can be extracted standalone and still scaffold a working
// app.
//
//   node skill/agent-face/scripts/sync-template.mjs            # (re)write the template
//   node skill/agent-face/scripts/sync-template.mjs --check    # verify parity, exit 1 on drift
//   node skill/agent-face/scripts/sync-template.mjs --help
//
// The --check mode is what CI (and the "re-run sync after editing root app
// files" rule in CLAUDE.md) uses to fail fast on divergence. Because the SAME
// manifest drives both writing and checking, the two can never disagree.
//
// No external deps, no Claude/harness-specific tooling — plain Node ESM so any
// harness can run it.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/ -> agent-face/ -> skill/ -> repo root
const ROOT = join(HERE, "..", "..", "..");
const TEMPLATE_DIR = join(ROOT, "skill", "agent-face", "assets", "app-template");

// --- Manifest: what the deployable template is made of -----------------------

// Directories copied wholesale (recursively), minus the EXCLUDE rules below.
const COPY_DIRS = ["app", "components", "lib", "public", "scripts"];

// Individual config files copied verbatim from the repo root.
const COPY_FILES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "next.config.mjs",
  "postcss.config.mjs",
  "vercel.json",
  "Dockerfile",
  "docker-compose.yml",
  ".dockerignore",
  ".env.example",
];

// Anything matching these is NEVER packaged: install output, build output,
// regenerated binaries, tests, and editor/VCS cruft. Keeps the template a lean
// deployable app (its own .gitignore mirrors these too).
const EXCLUDE_SEGMENTS = new Set([
  "node_modules",
  ".next",
  ".vercel",
  "coverage",
]);
// public/vad + public/models are large binaries regenerated at build time
// (scripts/setup-vad-assets.mjs) / downloaded at runtime — never snapshot them.
const EXCLUDE_PREFIXES = [
  ["public", "vad"].join(sep),
  ["public", "models"].join(sep),
];
const EXCLUDE_SUFFIXES = [".test.ts", ".test.tsx", ".tsbuildinfo"];
const EXCLUDE_BASENAMES = new Set([".gitkeep", ".DS_Store"]);

function isExcluded(relPath) {
  const parts = relPath.split(sep);
  if (parts.some((p) => EXCLUDE_SEGMENTS.has(p))) return true;
  if (EXCLUDE_PREFIXES.some((p) => relPath === p || relPath.startsWith(p + sep)))
    return true;
  const base = parts[parts.length - 1];
  if (EXCLUDE_BASENAMES.has(base)) return true;
  if (EXCLUDE_SUFFIXES.some((s) => base.endsWith(s))) return true;
  return false;
}

// --- Generated (template-authored) files -------------------------------------
// These are NOT copied from the root; the template owns them. They live in the
// script so --check verifies their content too.

const NEXT_ENV_DTS = `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`;

const TEMPLATE_GITIGNORE = `# Scaffolded app — ignore install/build output and secrets.

# dependencies
node_modules/

# next.js
.next/
out/
build/
*.tsbuildinfo

# env — never commit secrets
.env
.env*.local

# vercel
.vercel/

# generated at build time from node_modules (scripts/setup-vad-assets.mjs)
public/vad/

# ML model cache (browser Whisper / Kokoro downloads)
public/models/

# misc
.DS_Store
*.log
`;

const TEMPLATE_README = `# Agent Face — app template

This directory is a **self-contained, deployable snapshot** of the Agent Face
web app, packaged inside the \`agent-face\` skill. It is what
\`scripts/scaffold.mjs\` copies into a target directory.

> **Do not edit files here by hand.** The repo-root app is the single source of
> truth; this template is regenerated from it by
> \`skill/agent-face/scripts/sync-template.mjs\`. Run that script (or
> \`--check\` in CI) to keep the two in lock-step.

## Run it

\`\`\`bash
cp .env.example .env.local     # add >=1 provider key, or wire your running agent (both optional)
npm install
npm run dev                    # http://localhost:3000, then press "talk"
\`\`\`

With **zero keys** it still runs: speech-to-text uses in-browser Whisper
(WebGPU, private, offline) and speech-out uses the browser Web Speech API. Add a
key or wire a local agent to unlock hosted models and higher-fidelity lip-sync.

## Deploy

\`\`\`bash
npm run build && npm start                 # self-host (Node)
docker compose up --build                  # self-host (Docker, next to your agent)
\`\`\`

or push to Vercel. See the skill references for the full contract:

- \`references/backends.md\` — wiring a brain (Mode A keys or a Mode B running agent) + every env name
- \`references/architecture.md\` — the mic -> STT -> /api/chat -> TTS -> lip-sync -> face pipeline
- \`references/deploy.md\` — deploying to Vercel or self-hosting with Docker
- \`references/portability.md\` — running the skill on a non-Claude harness

All provider keys are **server-side only** (never \`NEXT_PUBLIC_*\`) and optional;
missing keys degrade gracefully.
`;

function generatedFiles() {
  return new Map([
    ["next-env.d.ts", Buffer.from(NEXT_ENV_DTS, "utf8")],
    [".gitignore", Buffer.from(TEMPLATE_GITIGNORE, "utf8")],
    ["README.md", Buffer.from(TEMPLATE_README, "utf8")],
  ]);
}

// --- Walk helpers -------------------------------------------------------------

function walk(absDir, baseAbs, out) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    const rel = relative(baseAbs, abs);
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) {
      walk(abs, baseAbs, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

// Build the desired template contents: relPath (posix-independent, using OS sep
// internally) -> Buffer.
function collectDesired() {
  const desired = new Map();

  for (const dir of COPY_DIRS) {
    const absDir = join(ROOT, dir);
    if (!existsSync(absDir)) continue;
    const files = [];
    walk(absDir, ROOT, files);
    for (const rel of files) desired.set(rel, readFileSync(join(ROOT, rel)));
  }

  for (const file of COPY_FILES) {
    const abs = join(ROOT, file);
    if (existsSync(abs)) desired.set(file, readFileSync(abs));
  }

  for (const [rel, buf] of generatedFiles()) desired.set(rel, buf);

  return desired;
}

// List the files currently present in the template (same EXCLUDE rules, so a
// stray node_modules/.next from a local build doesn't count as drift).
function collectActual() {
  const actual = new Map();
  if (!existsSync(TEMPLATE_DIR)) return actual;
  const files = [];
  walk(TEMPLATE_DIR, TEMPLATE_DIR, files);
  for (const rel of files) actual.set(rel, readFileSync(join(TEMPLATE_DIR, rel)));
  return actual;
}

// --- Commands -----------------------------------------------------------------

function diff(desired, actual) {
  const missing = []; // in desired, absent from template
  const changed = []; // present but bytes differ
  const extra = []; // in template, not desired

  for (const [rel, buf] of desired) {
    const cur = actual.get(rel);
    if (!cur) missing.push(rel);
    else if (!cur.equals(buf)) changed.push(rel);
  }
  for (const rel of actual.keys()) {
    if (!desired.has(rel)) extra.push(rel);
  }
  return { missing, changed, extra };
}

function runCheck() {
  const desired = collectDesired();
  const actual = collectActual();
  const { missing, changed, extra } = diff(desired, actual);

  if (missing.length || changed.length || extra.length) {
    console.error("✗ app-template is OUT OF SYNC with the repo-root app.\n");
    for (const rel of missing.sort()) console.error(`  missing:  ${rel}`);
    for (const rel of changed.sort()) console.error(`  changed:  ${rel}`);
    for (const rel of extra.sort()) console.error(`  extra:    ${rel}`);
    console.error(
      "\nRun: node skill/agent-face/scripts/sync-template.mjs  (then commit the template)",
    );
    process.exit(1);
  }

  console.log(`✓ app-template is in sync (${desired.size} files).`);
}

function runSync() {
  const desired = collectDesired();
  const actual = collectActual();
  const { missing, changed, extra } = diff(desired, actual);

  for (const [rel, buf] of desired) {
    const abs = join(TEMPLATE_DIR, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
  }
  for (const rel of extra) rmSync(join(TEMPLATE_DIR, rel), { force: true });

  const written = missing.length + changed.length;
  console.log(
    `✓ synced app-template: ${desired.size} files ` +
      `(${written} written/updated, ${extra.length} removed).`,
  );
}

function help() {
  console.log(
    `sync-template.mjs — regenerate the packaged app template from the repo-root app.

Usage:
  node skill/agent-face/scripts/sync-template.mjs            (re)write the template
  node skill/agent-face/scripts/sync-template.mjs --check    verify parity, exit 1 on drift
  node skill/agent-face/scripts/sync-template.mjs --help     show this help

The repo-root app is canonical; the template is a synced deployable snapshot.`,
  );
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  help();
} else if (args.includes("--check")) {
  runCheck();
} else {
  runSync();
}
