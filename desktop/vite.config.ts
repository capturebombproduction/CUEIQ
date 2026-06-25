import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The desktop renderer reuses the web app's components + lib straight from the repo
// root via the same "@/..." alias, so the look + logic stay identical. The shared
// Supabase client reads process.env.NEXT_PUBLIC_* — we inject those at build time so
// it works unmodified (the anon key is public, same as the web build).
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Override JUST the Supabase client with a localStorage-backed one (the web
      // lib's cookie session doesn't work under Electron's file:// origin). MUST
      // come before the "@" entry — alias matching takes the first hit, and "@"
      // also matches "@/lib/supabase/client".
      "@/lib/supabase/client": fileURLToPath(
        new URL("./src/shims/supabase-client.ts", import.meta.url)
      ),
      // "@/..." → repo root (shared components / lib), "~/..." → desktop src.
      "@": repoRoot,
      "~": fileURLToPath(new URL("./src", import.meta.url)),
      // next/* shims so reused client components keep working without Next.
      "next/navigation": fileURLToPath(new URL("./src/shims/next-navigation.tsx", import.meta.url)),
      "next/link": fileURLToPath(new URL("./src/shims/next-link.tsx", import.meta.url)),
      "next/dynamic": fileURLToPath(new URL("./src/shims/next-dynamic.tsx", import.meta.url)),
    },
  },
  define: {
    "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://kewyqqxohckurwuepucv.supabase.co"
    ),
    "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": JSON.stringify(
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "sb_publishable_x7v5zxGEJFfx6L5Yd2fYzg_xwynxSrW"
    ),
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
    // The web origin that hosts the /api/audio/presign route. The desktop app has
    // no API routes of its own, so it calls the web app's route cross-origin (with
    // a Bearer token) to mint R2 presigned URLs. See src/main.tsx.
    "process.env.CUEIQ_WEB_ORIGIN": JSON.stringify(
      process.env.CUEIQ_WEB_ORIGIN ?? "https://cueiq-mu.vercel.app"
    ),
  },
  server: { port: 5273 },
  // Electron loads from file:// → relative asset paths.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
