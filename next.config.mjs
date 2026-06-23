/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Tree-shake big barrel-export packages so a route only bundles the icons /
  // primitives it actually uses (lucide-react has ~1k icons; we import a handful
  // per file). Next 14.2 auto-optimizes some of these, but listing them is explicit
  // and harmless.
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  env: {
    // Stamp the build's git commit into the client so feedback + captured errors
    // record WHICH build they came from. Vercel sets VERCEL_GIT_COMMIT_SHA; "dev"
    // locally. See lib/app-version.ts.
    NEXT_PUBLIC_COMMIT: (process.env.VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 7),
  },
};

export default nextConfig;
