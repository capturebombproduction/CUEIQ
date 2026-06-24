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
  // Conservative security headers on every response. (A full Content-Security-Policy
  // is intentionally deferred: the no-flash bootstrap <script> in app/layout.tsx is
  // inline and would need a per-request nonce or hash — revisit when we add CSP.)
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" }, // no embedding (clickjacking)
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
