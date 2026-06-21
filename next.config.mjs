/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    // Stamp the build's git commit into the client so feedback + captured errors
    // record WHICH build they came from. Vercel sets VERCEL_GIT_COMMIT_SHA; "dev"
    // locally. See lib/app-version.ts.
    NEXT_PUBLIC_COMMIT: (process.env.VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 7),
  },
};

export default nextConfig;
