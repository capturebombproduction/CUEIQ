// The build's git commit (wired in next.config from VERCEL_GIT_COMMIT_SHA), so
// feedback + auto-captured errors record WHICH build they came from. "dev" locally.
export const APP_VERSION = process.env.NEXT_PUBLIC_COMMIT || "dev";
