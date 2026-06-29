import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests cover the PURE logic the app's correctness hangs on (RBAC, live
// authority). They run in node, never touch Supabase / the network / the DOM,
// and are invisible to `next build` (test files aren't imported by app code).
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "lib/**/*.test.tsx"],
  },
  resolve: {
    // Mirror the tsconfig "@/*" path alias so tests import like app code does.
    alias: { "@": path.resolve(__dirname) },
  },
});
