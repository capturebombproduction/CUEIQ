// Desktop-project setup: stand in for vite's `define`.
//
// desktop/vite.config.ts substitutes process.env.NEXT_PUBLIC_* TEXTUALLY at build
// time, so the packaged renderer never reads a real env. There is no such step
// under vitest, and the reused web modules read these at module scope — a missing
// one is a `TypeError: Cannot read properties of undefined (reading 'trim')`
// thrown during import, before any test body runs.
//
// These are PLACEHOLDERS, deliberately not the production values vite.config.ts
// bakes in. Nothing here should ever reach the network — but "should" was doing all
// the work: four desktop test files do not mock @/lib/supabase/client, so a query
// that escapes its double would have been aimed at the REAL project ref, with a
// long-lived anon key, from a unit test. `.invalid` is reserved by RFC 2606 and
// cannot resolve, so that mistake now fails as DNS instead of succeeding quietly
// against production data.
//
// It must still parse as an https URL: desktop/src/shims/supabase-client.ts hands
// it straight to createClient(), which throws on a malformed one.
//
// ⚠️ NOT the source of truth for the packaged app or for the offline smoke.
// desktop/scripts/make-smoke-seed.mjs derives the seed's project ref, and
// run-smoke.mjs the network-cut probe URL, by reading desktop/vite.config.ts —
// checked, neither reads this file. Change the real default there, not here.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://desktop-tests.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "sb_publishable_test_anon_key";
process.env.NEXT_PUBLIC_COMMIT ??= "desktop-test";
process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ??= "";
process.env.CUEIQ_WEB_ORIGIN ??= "https://cueiq-mu.vercel.app";

// window.cueiqNative is deliberately NOT defined here. Its absence is what the
// shared web components branch on to stay browser-inert, so defining it globally
// would make every desktop test run the native path whether it meant to or not.
// A test that wants the Electron bridge installs its own and removes it after.
