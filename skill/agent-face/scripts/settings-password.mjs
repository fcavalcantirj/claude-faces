#!/usr/bin/env node
// settings-password.mjs — provision the GUI env editor's master password.
//
// Produces the FACE_SETTINGS_PASSWORD_HASH line (scrypt, node:crypto only) that
// the app's /api/env verifier (lib/settings/env-admin.ts) accepts. The two
// implementations are hand-kept twins pinned together by the PARITY test in
// settings-password.test.ts — change the format in BOTH places or not at all.
//
// Usage:
//   node settings-password.mjs                 # prompts (muted), prints the line
//   node settings-password.mjs 'my password'   # non-interactive, prints the line
// Paste the printed line into .env.local (or the Vercel-style dashboard of a
// host that can persist env), then restart. The plaintext is never stored.

import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const MIN_PASSWORD_LENGTH = 12;

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;

/**
 * `scrypt:N:r:p:<salt b64url>:<hash b64url>` — same format as env-admin.ts.
 * Colon-separated ON PURPOSE: @next/env dotenv-expansion eats `$`-segments in
 * .env.local values (a $-separated hash loaded back as "scrypt6384").
 */
export function hashPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`the settings password needs at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LEN, { ...SCRYPT, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

/** Append or replace ONLY the FACE_SETTINGS_PASSWORD_HASH line; never touch others. */
export function upsertPasswordHashLine(content, hashLineValue) {
  const line = `FACE_SETTINGS_PASSWORD_HASH=${hashLineValue}`;
  const lines = content.split("\n");
  let replaced = false;
  const next = lines.map((l) => {
    if (l.trim().startsWith("FACE_SETTINGS_PASSWORD_HASH=") && !replaced) {
      replaced = true;
      return line;
    }
    return l;
  });
  if (replaced) return next.join("\n");
  const sep = content.length && !content.endsWith("\n") ? "\n" : "";
  return `${content}${sep}${line}\n`;
}

/**
 * Muted prompt. Resolves '' when the user just hits Enter — and ALSO on
 * EOF/closed stdin (^D, piped input running dry): an unresolved promise here
 * hangs the whole launcher silently (found via PTY repro, 2026-07-20).
 * Streams injectable for tests; defaults to the real TTY.
 */
export function promptForPassword(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: true });
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      rl.close();
      output.write("\n");
      resolve(answer);
    };
    // Suppress echo: readline's documented-enough internal hook; worst case a
    // non-supporting runtime just echoes (still functional).
    const anyRl = rl;
    anyRl._writeToOutput = function (chunk) {
      if (typeof chunk === "string" && chunk.includes(question)) {
        this.output.write(chunk);
      }
    };
    rl.question(question, finish);
    // EOF / stream close without a line: readline fires 'close' and the
    // question callback never runs — treat as "skipped", never hang.
    rl.on("close", () => finish(""));
  });
}

async function main() {
  const arg = process.argv[2];
  const pw = arg ?? (process.stdin.isTTY ? await promptForPassword("Settings password (min 12 chars): ") : "");
  if (!pw) {
    console.error("No password given — nothing to do.");
    process.exit(2);
  }
  try {
    console.log(`FACE_SETTINGS_PASSWORD_HASH=${hashPassword(pw)}`);
    console.error("(paste this line into .env.local, then restart the server)");
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
