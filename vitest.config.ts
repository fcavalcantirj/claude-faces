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
      include: ["app/**", "lib/**", "components/**", "skill/agent-face/scripts/**"],
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
      ],
      // A RATCHET, not a target. Measured 2026-07-18 at 58.21/57.68/58.58/60.95;
      // these sit just below that so normal churn does not flake the build, but
      // a real regression fails it.
      //
      // The stated project target is 80% and we are NOT there. The gap is almost
      // entirely React components sitting at 0% — no component testing library is
      // installed, so they are exercised only by Playwright, which this provider
      // cannot see. Business logic is already healthy: lib/settings 100,
      // lib/providers 88.6, lib/chat 87.2, lib/face 86.4, lib/audio 84.5,
      // lib/tts 82.2. See the "component-level test coverage" task in prd.json.
      //
      // RAISE THESE as coverage improves. Never lower them to make a build pass.
      thresholds: {
        statements: 57,
        branches: 56,
        functions: 57,
        lines: 59,
      },
    },
  },
});
