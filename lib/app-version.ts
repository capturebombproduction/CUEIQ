// The build's git commit (wired in next.config from VERCEL_GIT_COMMIT_SHA), so
// feedback + auto-captured errors record WHICH build they came from. "dev" locally.

// Read through a try/catch: the bundler inlines this literal (web = next.config
// `env`, desktop = vite `define`), but if a build ever misses it the bare `process`
// is a ReferenceError at module eval — and the Electron renderer has no `process`
// at all (contextIsolation on, node integration off), so importing this module
// there would white-screen the app instead of just falling back to "dev".
function buildCommit(): string | undefined {
  try {
    return process.env.NEXT_PUBLIC_COMMIT;
  } catch {
    return undefined;
  }
}

export const APP_VERSION = buildCommit() || "dev";
