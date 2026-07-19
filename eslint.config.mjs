// ESLint 9 flat config.
//
// This file did not exist until 2026-07-18, which meant `npm run lint` had NEVER
// run: package.json defined `"lint": "eslint ."` and depended on eslint ^9 +
// eslint-config-next ^16, but ESLint 9 dropped .eslintrc as a default lookup, so
// every invocation exited 2 with "couldn't find an eslint.config file". The
// script looked wired up and silently did nothing.
//
// eslint-config-next 16 ships NATIVE flat config (it exports an array), so no
// FlatCompat shim is needed — import it directly.

import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const config = [
  {
    // Nothing generated, vendored, or built is ours to lint.
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "coverage/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
      // Vendored EIDOLON particle-face source. Read-only reference — CLAUDE.md
      // forbids modifying it, so linting it would only produce unfixable noise.
      "reference/**",
      // A generated mirror of the repo-root app (sync-template.mjs). Linting it
      // would duplicate every root violation and double every fix.
      "skill/agent-face/assets/app-template/**",
      // Static assets, including the vendored ONNX runtime + Silero VAD bundles
      // fetched by scripts/setup-vad-assets.mjs. These are third-party build
      // output — they accounted for 161 of the first run's 189 findings, none of
      // them actionable by us.
      "public/**",
    ],
  },

  ...nextCoreWebVitals,
  ...nextTypeScript,

  {
    // Tests and harness scripts legitimately do things product code should not:
    // deliberate `any` at mock boundaries, non-null assertions on fixtures known
    // to exist, and unused capture vars when draining a stream.
    files: ["tests/**/*.ts", "**/*.test.ts", "**/*.test.tsx", "skill/agent-face/scripts/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },

  {
    // Unused code is an ERROR in first-party source, not a warning.
    //
    // eslint-config-next ships this as "warn". Combined with the React Compiler
    // downgrade below, that left NOTHING at error severity — `npm run lint`
    // exited 0 no matter what, and a deliberately injected unused variable did
    // not fail it. A gate that cannot fail is theatre. This restores real teeth:
    // the underscore prefix remains the escape hatch for intentionally-unused
    // bindings.
    files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Upstream (eslint-plugin-react-hooks recommended) ships exhaustive-deps
      // at "warn" — this repo wants teeth: a stale dependency array is a real
      // bug (a handler closing over dead state), not a style nit. The sanctioned
      // escape hatch stays a commented eslint-disable naming the omitted dep.
      "react-hooks/exhaustive-deps": "error",
    },
  },

  // The React Compiler downgrade block that lived here (2026-07-18 → 19) is
  // GONE, per its own instruction not to become permanent furniture: all 26
  // react-hooks findings were fixed rule-family by rule-family, and every rule
  // now runs at its upstream "error" severity (exhaustive-deps is explicitly
  // pinned to "error" in the first-party block above because upstream ships it
  // as "warn").
];

export default config;
