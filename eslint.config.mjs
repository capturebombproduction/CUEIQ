// ESLint 10 flat config (Next 16 removed `next lint` and .eslintrc). Same two presets
// the old .eslintrc.json extended; `npm run lint` keeps `next lint`'s scope: app,
// components, lib (+ the root proxy.ts) - not desktop/, scripts/ or the git-ignored
// review-shots/ and backups/.
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-plugin-react-hooks 7 (via eslint-config-next 16) adds the React
    // Compiler's rules to "recommended"; v5 had only the two below. This app does
    // not run the compiler, and on 2026-10-23 they flagged 159 sites - live-mode,
    // the practice player, the metronome - that work and are covered by tests.
    // Rewriting zero-tolerance audio code to satisfy a compiler we do not use is not
    // an upgrade step, so they stay off; turn one on only together with the code it
    // flags.
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/static-components": "off",
      "react-hooks/use-memo": "off",
      "react-hooks/void-use-memo": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/incompatible-library": "off",
      "react-hooks/immutability": "off",
      "react-hooks/globals": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/error-boundaries": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-render": "off",
      "react-hooks/unsupported-syntax": "off",
      "react-hooks/config": "off",
      "react-hooks/gating": "off",
    },
  },
  {
    // ESLint 9+ reports a disable comment that suppresses nothing; ESLint 8 under
    // `next lint` did not. The existing ones carry their reasons - keep them.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
