#!/usr/bin/env node
// scaffold.mjs — copy the packaged Agent Face app template into a target dir.
//
// This is the FIRST script a host agent runs to "give itself a face": it
// materializes the self-contained web app (assets/app-template/) into a
// working directory the user then installs, runs, and deploys.
//
//   node skill/agent-face/scripts/scaffold.mjs                 # -> ./agent-face-app
//   node skill/agent-face/scripts/scaffold.mjs ./my-face       # custom target
//   node skill/agent-face/scripts/scaffold.mjs ./my-face --force    # overwrite a non-empty dir
//   node skill/agent-face/scripts/scaffold.mjs ./my-face --install  # also run `npm install`
//   node skill/agent-face/scripts/scaffold.mjs --help
//
// The template is the single-source-of-truth snapshot kept in lock-step with
// the repo-root app by sync-template.mjs. The template path is resolved
// RELATIVE TO THIS SCRIPT, so scaffolding works when the skill is extracted
// standalone (dropped into any harness's skills dir), not just from the repo.
//
// No external deps, no harness-specific tooling — plain Node ESM +
// node:fs/node:path (no bash-only `cp` semantics) so any harness on any OS can
// run it.

import {
  existsSync,
  readdirSync,
  mkdirSync,
  cpSync,
} from "node:fs";
import { dirname, join, resolve, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/ -> agent-face/ -> assets/app-template
const TEMPLATE_DIR = join(HERE, "..", "assets", "app-template");
const DEFAULT_TARGET = "./agent-face-app";

// Never copy install/build output even if a local build left it in the
// template dir — the scaffolded app regenerates these itself.
const SKIP_SEGMENTS = new Set(["node_modules", ".next", ".vercel", "coverage"]);

function help() {
  console.log(
    `scaffold.mjs — copy the Agent Face app template into a target directory.

Usage:
  node scaffold.mjs [target] [options]

Arguments:
  target            Directory to create the app in (default: ${DEFAULT_TARGET}).

Options:
  --force           Overwrite / merge into a non-empty target directory.
  --install         Run \`npm install\` in the target after copying.
  --help, -h        Show this help.

After scaffolding:
  cd <target>
  cp .env.example .env.local     # add >=1 provider key, or wire your running agent (both optional)
  node "${join(HERE, "start.mjs")}"
      # one command: installs deps on first run, starts the app
      # (add --port <n> if :3000 is taken by another project)
  # or by hand: npm install && npm run dev   (http://localhost:3000)

Every provider key is server-side only and optional; with zero keys the app
still runs on in-browser Whisper + Web Speech.`,
  );
}

// A directory counts as "non-empty" if it holds anything other than the
// dotfiles a fresh git clone / editor might drop (.git, .DS_Store).
function isNonEmptyDir(dir) {
  if (!existsSync(dir)) return false;
  const entries = readdirSync(dir).filter(
    (name) => name !== ".git" && name !== ".DS_Store",
  );
  return entries.length > 0;
}

function parseArgs(argv) {
  const opts = { force: false, install: false, help: false, target: null };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--install") opts.install = true;
    else if (arg.startsWith("-")) {
      console.error(`✗ Unknown option: ${arg}\n`);
      help();
      process.exit(2);
    } else if (opts.target === null) {
      opts.target = arg;
    } else {
      console.error(`✗ Unexpected extra argument: ${arg}`);
      process.exit(2);
    }
  }
  if (opts.target === null) opts.target = DEFAULT_TARGET;
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }

  if (!existsSync(TEMPLATE_DIR)) {
    console.error(
      `✗ App template not found at:\n    ${TEMPLATE_DIR}\n` +
        `The skill package looks incomplete (missing assets/app-template/).`,
    );
    process.exit(1);
  }

  const target = resolve(opts.target);

  if (isNonEmptyDir(target) && !opts.force) {
    console.error(
      `✗ Target is not empty:\n    ${target}\n` +
        `Refusing to overwrite. Re-run with --force to merge into it, or pick an empty directory.`,
    );
    process.exit(1);
  }

  mkdirSync(target, { recursive: true });

  // Cross-platform recursive copy with a filter that drops build/install
  // output. cpSync's filter is called for every source path; returning false
  // skips that entry (and, for a directory, its whole subtree).
  cpSync(TEMPLATE_DIR, target, {
    recursive: true,
    force: true,
    filter: (src) => {
      const segments = src.slice(TEMPLATE_DIR.length).split(sep);
      return !segments.some((s) => SKIP_SEGMENTS.has(s));
    },
  });

  console.log(`✓ Scaffolded Agent Face into:\n    ${target}\n`);

  if (opts.install) {
    console.log("Running npm install …\n");
    const res = spawnSync("npm", ["install"], {
      cwd: target,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (res.status !== 0) {
      console.error(
        `\n✗ npm install failed (exit ${res.status ?? "unknown"}). ` +
          `Run it manually in ${target}.`,
      );
      process.exit(res.status || 1);
    }
    console.log("\n✓ Dependencies installed.\n");
  }

  const rel = opts.target.startsWith("/") ? target : opts.target;
  const name = basename(target);
  console.log("Next steps:");
  console.log(`  cd ${rel}`);
  console.log(
    "  cp .env.example .env.local     # add >=1 provider key, or wire your running agent (both optional)",
  );
  console.log(`  node "${join(HERE, "start.mjs")}"`);
  console.log(
    `      # one command: installs deps${opts.install ? "" : " on first run"}, starts the app, opens the browser`,
  );
  console.log("      # (add --port <n> if :3000 is taken by another project)");
  console.log(
    `  # or by hand: ${opts.install ? "" : "npm install && "}npm run dev   (http://localhost:3000, then press "talk")\n`,
  );
  console.log(
    `The \"${name}\" app runs with zero keys (in-browser Whisper + Web Speech); ` +
      "add a key or wire your running agent for hosted models and FFT lip-sync.",
  );
}

main();
