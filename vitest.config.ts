import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror the tsconfig "@/*" path alias so tests can import app modules the
    // same way the app does.
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
      // Measure FIRST-PARTY source only. Counting vendored or generated code
      // would move the percentage without telling us anything about the code we
      // actually wrote.
      include: ["app/**", "lib/**", "components/**"],
      exclude: [
        "**/node_modules/**",
        "**/.next/**",
        // Vendored EIDOLON reference source — never modified, not ours to test.
        "reference/**",
        // Generated mirror of the root app; testing it would double-count.
        "skill/agent-face/assets/app-template/**",
        // The tests and their helpers/fixtures are not the subject under test.
        "tests/**",
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.spec.ts",
        // Config and type-only declarations carry no runtime logic.
        "**/*.config.*",
        "**/*.d.ts",
        // VIEW CODE IS OWNED BY PLAYWRIGHT, NOT THIS RATCHET (Felipe's decision,
        // 2026-07-19). React components and the two page shells are exercised for
        // real in a browser by tests/e2e/*, which v8 cannot observe, so counting
        // them here reported an honest-looking 0% that measured the tooling gap,
        // not a testing gap. Their behaviour logic lives in lib/ (e.g. the
        // settings panel's reconciliation is lib/settings/panel-model.ts, 100%
        // covered). Unit tests here would re-prove what Playwright already proves.
        "components/**",
        "app/page.tsx",
        "app/layout.tsx",
        // React hooks cannot execute outside a React renderer, and installing a
        // component-test renderer is exactly what was decided against — so like
        // the components they serve, hooks are Playwright's. Their behaviour
        // lives in the non-hook modules they wrap (capabilities.ts 97%,
        // conversation.ts 87%, orchestrator.ts 76% — all measured here).
        "lib/use-*.ts",
        "lib/face/use-emotion.ts",
        // One-line Tailwind classname helper (cn) — view-layer glue.
        "lib/utils.ts",
        // Static coordinate table (data, not logic) — a test asserting a table
        // equals itself would raise the number while proving nothing.
        "lib/face-points.ts",
        // The skill CLI scripts are verified END-TO-END by the test:skill gate
        // (smoke.mjs spawns scaffold/check-env/dev/deploy as subprocesses and
        // asserts on their behaviour), by the parity gate (sync-template.mjs)
        // and by Playwright's webServer (dev.mjs) — none of which v8 can
        // observe, for the same reason it cannot see browser execution. Their
        // extracted pure logic (e.g. dev.mjs findPidsOnPort) keeps its
        // in-process unit tests; only the file-level percentage is dropped from
        // the ratchet, because it measured the tooling gap, not a testing gap.
        // EXPLICITLY EXCLUDED (not just absent from include): on Linux the v8
        // provider still reported the three test-imported scripts when they
        // merely fell outside the include list, dragging the summary ~6 points
        // below the macOS number and failing the ratchet in the container.
        // An exclude entry states the decision unambiguously on every platform.
        "skill/agent-face/scripts/**",
      ],
      // A RATCHET, not a target. Scope excludes browser-owned view code, hooks
      // and data tables (above), so these numbers measure BUSINESS LOGIC ONLY:
      // lib/ minus hooks/face-points, plus the app/api routes. Measured
      // 2026-07-19 on that scope at 83.57/74.90/83.47/87.39; thresholds sit
      // just below measured so normal churn does not flake the build, but a
      // real regression fails it.
      //
      // The 80% floor is genuinely met for statements, functions and lines.
      // BRANCHES ARE NOT THERE (74.9%): the shortfall is real and concentrated
      // in lib/stt (63.6% — index.ts, whisper-per-engine error paths) and
      // lib/tts (69.8%). That is a testing gap, not a tooling gap — close it
      // with tests, then raise the branches threshold.
      //
      // RAISE THESE as coverage improves. Never lower them to make a build pass.
      thresholds: {
        statements: 83,
        branches: 74,
        functions: 83,
        lines: 87,
      },
    },
  },
});
