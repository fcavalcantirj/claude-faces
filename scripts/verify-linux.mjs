#!/usr/bin/env node
// Run the full gate on a CLEAN LINUX MACHINE, using Docker.
//
// WHY: `npm run verify` proves the gates pass on YOUR machine. It cannot prove
// they pass on anyone else's. On 2026-07-18 that distinction was not academic —
// the gates were green on macOS while two of them FAILED on Linux, because
// dev.mjs located the dev-server process with `lsof` and a stock node image has
// no lsof, ss, fuser or netstat. It returned "port is free" and skipped the kill
// silently. Nobody would have caught that without running somewhere else.
//
// This is deliberately NOT a GitHub Actions replacement and needs no account,
// no runner, no billing — just Docker. It ships the repo's TRACKED files into a
// clean container, installs from the lockfile, and runs the same
// `npm run verify` the workflow would.
//
//   npm run verify:linux            # the 6 non-browser gates on Linux
//   npm run verify:linux -- --keep  # leave the container's /app for poking at
//
// Exit code mirrors the in-container run.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEEP = process.argv.includes("--keep");
const IMAGE = process.env.VERIFY_LINUX_IMAGE ?? "node:22-bookworm";

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

// --- preflight --------------------------------------------------------------

if (run("docker", ["--version"]).error) {
  console.error(
    "\nDocker is not installed.\n\n" +
      "This check is OPTIONAL — `npm run verify` covers the same gates on this\n" +
      "machine. Linux verification just catches platform-specific bugs that a\n" +
      "single OS cannot reveal. Install Docker to enable it.\n",
  );
  process.exit(127);
}
if (run("docker", ["info"]).status !== 0) {
  console.error("\nDocker is installed but the daemon is not running. Start it and retry.\n");
  process.exit(127);
}

// --- package the repo -------------------------------------------------------
//
// Only git-TRACKED files, so node_modules and local junk never leak in — and
// crucially so the container installs from the lockfile exactly like CI.
//
// COPYFILE_DISABLE=1 + --no-xattrs are LOAD-BEARING on macOS: without them BSD
// tar writes AppleDouble `._*` resource forks into the archive, which then break
// eslint ("Parsing error: Invalid character") and the template parity check
// (phantom `app/._.gitkeep`). That cost a confusing debugging round.

const staging = mkdtempSync(join(tmpdir(), "cf-verify-linux-"));
const tarPath = join(staging, "repo.tar");
const env = { ...process.env, COPYFILE_DISABLE: "1" };

console.log(`\nPackaging tracked files → ${IMAGE}…`);

const files = run("git", ["ls-files", "-z"], { env, maxBuffer: 64 * 1024 * 1024 });
if (files.status !== 0) {
  console.error("git ls-files failed — is this a git repository?");
  process.exit(1);
}

const tar = run("tar", ["--null", "--no-xattrs", "-cf", tarPath, "-T", "-"], {
  input: files.stdout,
  env,
  maxBuffer: 512 * 1024 * 1024,
});
if (tar.status !== 0) {
  console.error("tar failed:\n" + (tar.stderr ?? ""));
  process.exit(1);
}

// --- run the gates in the container ----------------------------------------

const script = [
  "mkdir -p /app && tar -xf /src.tar -C /app && cd /app",
  'echo "container: $(node -v) $(uname -s)/$(uname -m)"',
  "npm ci --no-audit --no-fund > /tmp/ci.log 2>&1 || { echo 'npm ci FAILED'; tail -30 /tmp/ci.log; exit 1; }",
  "npm run verify",
].join(" && ");

console.log("Running the gate inside a clean container…\n");

const docker = run(
  "docker",
  ["run", "--rm", "-v", `${tarPath}:/src.tar:ro`, IMAGE, "bash", "-lc", script],
  { stdio: "inherit" },
);

if (!KEEP) rmSync(staging, { recursive: true, force: true });
else console.log(`\n(kept staging archive at ${tarPath})`);

const code = docker.status ?? 1;
console.log(
  code === 0
    ? "\nLinux verification PASSED — the gates hold on a machine that is not yours.\n"
    : "\nLinux verification FAILED — see the gate output above.\n",
);
process.exit(code);
