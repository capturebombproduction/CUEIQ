# Stack upgrade readiness — Next 16 / Tailwind 4 / TS 6

> Static assessment (code grep + known breaking changes), **not** a build-proven
> probe. Recommendation stands: **majors stay DEFERRED while the label is actively
> running shows** — do them in a burn-in window, never right before a gig. This doc
> is the ready-to-execute checklist so the eventual migration is mechanical.
>
> As of 2026-06-28: Next `15.5.19` · Tailwind `3.4.x` · TS `5.9` · ESLint `8.57`
> (`npm outdated` latest: next 16.2.9 · tailwind 4.3.1 · ts 6.0.3 · eslint 10.6).
> `npm audit` = 0. Node `20.19` (satisfies Next 16's ≥20.9).

## Next 15 → 16 — LOW surface (mostly mechanical)
Grepped the whole tree for the usual 15→16 breakers and found **none**: no
`next/legacy/image`, no `next/amp`/`useAmp`, no `images.domains`, no pages-router
(`getServerSideProps`/`getStaticProps`/`next/router`), no `@next/font`. The app is
already modern App Router: `next/font/google` (Kanit, stable), `middleware.ts` with
`config.matcher` (supported), API routes on `export const runtime = "nodejs"`, React
19.2 (Next 16 requires 19). `next/image` isn't even used (only the auto type ref in
`next-env.d.ts`). `next.config.mjs` is tiny: `reactStrictMode`, `headers()`, `env`,
and `experimental.optimizePackageImports` (verify this key — it may have stabilized
in 16; harmless if it just warns).

**The one real change: `next lint` is removed in 16.** Today `package.json` has
`"lint": "next lint"` (it already prints the deprecation). Migration:
1. `npx @next/codemod@canary next-lint-to-eslint-cli .` (generates `eslint.config.mjs`
   flat config, rewrites the script).
2. Bump `eslint-config-next` 15 → 16 and likely `eslint` 8 → 9 (flat config; 8 is EOL).
3. `next@16`, then `npm run build` + `npx tsc --noEmit` + the new lint.

**Risk is not the code edits — it's subtle runtime/caching default shifts** on a live
app that only a full **auth-gated visual pass** (พี่'s eyeball: login → dashboard →
event → live → overview → practice) can catch. So: low effort, must-verify-visually.

## Tailwind 3 → 4 — MODERATE surface + real visual-regression risk
Bigger than Next 16. Current setup: `tailwind.config.ts` (`darkMode: ["class"]`,
`plugins: [require("tailwindcss-animate")]`, brand theme), `postcss.config.mjs` with
the `tailwindcss` plugin, and `@tailwind base/components/utilities` in
`app/globals.css`. Tailwind 4 changes the whole pipeline:
- `@tailwind …` directives → `@import "tailwindcss"`.
- PostCSS plugin moves to a separate package: `tailwindcss` → `@tailwindcss/postcss`
  (update `postcss.config.mjs`).
- Config goes CSS-first (`@theme`); a JS config can be retained via
  `@config "../tailwind.config.ts"` but some options change.
- `darkMode: ["class"]` → `@custom-variant dark` in CSS.
- `tailwindcss-animate` → the v4-compatible fork `tw-animate-css`.
- **Default palette + border-color default changed** (v3's implicit `gray-200`
  border is gone) → **visuals can shift app-wide** → needs a thorough brand eyeball
  ([[seishin-kakumei-brand]] colors must stay exact).
- Official path: `npx @tailwindcss/upgrade@latest` does most of it, then hand-fix.

## TS 5 → 6 / ESLint → 10 / @types/node → 26
- **TS 6**: do AFTER the above; run `tsc --noEmit` and fix any newly-strict inference.
  Low app risk but can surface in `lib/*` generics.
- **ESLint 10**: only meaningful once on flat config (comes with the Next 16 lint
  migration). Pair them.
- **@types/node 26**: trivial; bump with a `tsc` pass. (We're on Node 20 runtime, but
  the types can lead.)

## Recommended sequencing (when a burn-in window opens)
1. Next 16 + ESLint-CLI/flat-config + eslint 9 (one PR) → build + visual pass.
2. `@types/node` + TS 6 (small PR) → `tsc`.
3. Tailwind 4 **last and alone** (its own PR) → `@tailwindcss/upgrade` + full visual
   + brand-color diff. Highest regression risk, so isolate it.
Each on a branch/worktree, never `dev:main` straight to prod, and **not in the days
before a show** (the live-use stability priority overrides currency —
[[project-cueiq]] pivot).

## In-range patches (safe now, low value)
`lucide-react` 1.21→1.22, `postcss` 8.5.15→8.5.16 are the only non-major bumps. Held
back deliberately to avoid churning prod before shows; fold into the next real change.
