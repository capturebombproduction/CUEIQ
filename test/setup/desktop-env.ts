// Desktop-project setup: stand in for vite's `define`.
//
// desktop/vite.config.ts substitutes process.env.NEXT_PUBLIC_* TEXTUALLY at build
// time, so the packaged renderer never reads a real env. There is no such step
// under vitest, and the reused web modules read these at module scope — a missing
// one is a `TypeError: Cannot read properties of undefined (reading 'trim')`
// thrown during import, before any test body runs.
//
// The values are the same public defaults vite.config.ts bakes in (the anon key
// ships in every build; it is not a secret). Nothing here should ever reach the
// network: tests either mock the client or run with no network at all, and a real
// URL only exists so client construction succeeds.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://kewyqqxohckurwuepucv.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "sb_publishable_test_anon_key";
process.env.NEXT_PUBLIC_COMMIT ??= "desktop-test";
process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ??= "";
process.env.CUEIQ_WEB_ORIGIN ??= "https://cueiq-mu.vercel.app";

// window.cueiqNative is deliberately NOT defined here. Its absence is what the
// shared web components branch on to stay browser-inert, so defining it globally
// would make every desktop test run the native path whether it meant to or not.
// A test that wants the Electron bridge installs its own and removes it after.
