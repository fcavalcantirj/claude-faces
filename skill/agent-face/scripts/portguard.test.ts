// portguard.test.ts — unit coverage for the who-holds-the-port classifier.
//
// The port-freeing step used to kill WHATEVER held the port; the classifier
// makes it kill only processes that verifiably belong to this app (their cwd
// is inside the app dir, or their command line names it). Everything else is
// refused by default — the neighbor project's dev server on :3000 must
// survive a bare `start.mjs` run.

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyOccupant,
  describePid,
  isWithin,
  parseLsofCwd,
  planPortAction,
} from "./portguard.mjs";

// Real directories so realpath() inside the classifier has something to chew on.
const APP = mkdtempSync(join(tmpdir(), "portguard-app-"));
const OTHER = mkdtempSync(join(tmpdir(), "portguard-other-"));
mkdirSync(join(APP, "bridge"), { recursive: true });

describe("isWithin", () => {
  it("matches the dir itself and children, not lookalike prefixes", () => {
    expect(isWithin(APP, APP)).toBe(true);
    expect(isWithin(join(APP, "bridge"), APP)).toBe(true);
    expect(isWithin(`${APP}2`, APP)).toBe(false);
    expect(isWithin(OTHER, APP)).toBe(false);
  });
});

describe("classifyOccupant", () => {
  it("a process working inside the app dir is ours (stale dev server case)", () => {
    expect(
      classifyOccupant({ pid: 1, command: "next-server (v16.2.10)", cwd: APP }, APP),
    ).toBe("ours");
  });

  it("the bridge (cwd <app>/bridge) is ours", () => {
    expect(
      classifyOccupant(
        { pid: 2, command: "node src/server.mjs", cwd: join(APP, "bridge") },
        APP,
      ),
    ).toBe("ours");
  });

  it("a command line naming the app dir is ours even without a cwd", () => {
    expect(
      classifyOccupant(
        { pid: 3, command: `node ${join(APP, "bridge", "src", "server.mjs")}`, cwd: null },
        APP,
      ),
    ).toBe("ours");
  });

  it("ANOTHER project's dev server is foreign — the :3000 neighbor must survive", () => {
    expect(
      classifyOccupant({ pid: 4, command: "next-server (v16.2.10)", cwd: OTHER }, APP),
    ).toBe("foreign");
  });

  it("a process with no identity at all is unknown (never killed by default)", () => {
    expect(classifyOccupant({ pid: 5, command: null, cwd: null }, APP)).toBe("unknown");
  });

  // The /app-vs-/app2 trap, command-line edition: a sibling dir sharing the
  // app dir as a string prefix (claude-faces vs claude-faces-v2) must never
  // classify as ours just because the app path is a substring of its path.
  it("a sibling dir sharing the app path as a prefix is foreign (claude-faces vs claude-faces-v2)", () => {
    expect(
      classifyOccupant(
        { pid: 6, command: `node ${APP}-v2/server.js`, cwd: `${APP}-v2` },
        APP,
      ),
    ).toBe("foreign");
  });

  it("a command referencing a file INSIDE the app dir is still ours", () => {
    expect(
      classifyOccupant({ pid: 7, command: `node ${join(APP, "server.js")}`, cwd: null }, APP),
    ).toBe("ours");
  });

  it("a command ending exactly at the app dir is ours (boundary = end of string)", () => {
    expect(classifyOccupant({ pid: 8, command: `next dev ${APP}`, cwd: null }, APP)).toBe(
      "ours",
    );
  });
});

describe("planPortAction", () => {
  const ours = { pid: 10, command: "next-server", cwd: APP };
  const foreign = { pid: 11, command: "next-server", cwd: OTHER };

  it("kills when every occupant is ours", () => {
    expect(planPortAction([ours], APP)).toEqual({ kill: [10], refuse: [] });
  });

  it("refuses ATOMICALLY when any occupant is foreign (kills nothing)", () => {
    const plan = planPortAction([ours, foreign], APP);
    expect(plan.kill).toEqual([]);
    expect(plan.refuse.map((r) => r.pid)).toEqual([11]);
  });

  it("unknown occupants are refused like foreign ones", () => {
    const plan = planPortAction([{ pid: 12, command: null, cwd: null }], APP);
    expect(plan.kill).toEqual([]);
    expect(plan.refuse[0]).toMatchObject({ pid: 12, cls: "unknown" });
  });

  it("take: true overrides — everything dies, nothing is refused", () => {
    expect(planPortAction([ours, foreign], APP, { take: true })).toEqual({
      kill: [10, 11],
      refuse: [],
    });
  });
});

describe("parseLsofCwd", () => {
  it("extracts the n-line path from lsof -Fn output", () => {
    expect(parseLsofCwd("p123\nfcwd\nn/Users/x/dev/app\n")).toBe("/Users/x/dev/app");
  });

  it("returns null when there is no n line", () => {
    expect(parseLsofCwd("")).toBeNull();
  });
});

describe("describePid (live)", () => {
  it.skipIf(process.platform === "win32")(
    "identifies THIS process with a command and cwd on macOS/Linux",
    () => {
      const info = describePid(process.pid);
      expect(info.command).toBeTruthy();
      expect(info.cwd).toBeTruthy();
    },
  );

  it.skipIf(process.platform === "win32")(
    "a vanished PID yields nulls, not garbage",
    () => {
      // Spawn-and-reap a child so we hold a real-but-dead PID.
      const dead = spawnSync(process.execPath, ["-e", ""]);
      const info = describePid(dead.pid);
      expect(info.command).toBeNull();
      expect(info.cwd).toBeNull();
    },
  );

  it("rejects a non-integer pid without shelling out", () => {
    expect(describePid(Number.NaN)).toEqual({ pid: Number.NaN, command: null, cwd: null });
  });
});
