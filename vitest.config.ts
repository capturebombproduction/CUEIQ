import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

const repoRoot = path.resolve(__dirname);
const desktopSrc = path.resolve(__dirname, "desktop/src");

/** ⚠️ THE ONE THING THAT MAKES DESKTOP COMPONENT TESTS POSSIBLE AT ALL.
 *
 *  desktop/ is its own npm project, so desktop/node_modules holds a SECOND copy of
 *  react, react-dom, react-router-dom, lucide-react, the Radix packages… Two React
 *  copies in one process means every hook throws, and the message ("Cannot read
 *  properties of null (reading 'useContext')", raised from inside an icon) points
 *  at nothing resembling the cause.
 *
 *  Aliasing react alone is NOT enough, and this is the part that costs an hour if
 *  you rediscover it: vitest hands node_modules to Node's own loader, and Node then
 *  resolves lucide-react's `react` import by walking up from desktop/node_modules —
 *  the alias never gets asked, and `server.deps.inline` does not rescue it either.
 *  So EVERY dependency a desktop source file can import is pinned to the root copy
 *  when one exists; from there down, root resolution is internally consistent and
 *  @testing-library/react renders into the same React.
 *
 *  Computed from desktop/package.json rather than listed, because a hand-written
 *  list is one `npm i` away from being wrong in a way that reads as a component bug.
 */
function desktopDepsPinnedToRoot(): Record<string, string> {
  const desktopPkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "desktop/package.json"), "utf8")
  ) as { dependencies?: Record<string, string> };
  const alias: Record<string, string> = {};
  for (const name of Object.keys(desktopPkg.dependencies ?? {})) {
    const rootDir = path.join(repoRoot, "node_modules", name);
    const desktopDir = path.join(repoRoot, "desktop/node_modules", name);
    if (!fs.existsSync(rootDir)) continue; // desktop-only (electron-updater) — no clash
    // A major-version split would mean the test exercises different code than the
    // app ships, which is worse than the duplicate it is avoiding. Fail loudly.
    if (fs.existsSync(desktopDir)) {
      const major = (dir: string) =>
        String(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version).split(
          "."
        )[0];
      if (major(rootDir) !== major(desktopDir)) {
        throw new Error(
          `vitest.config.ts: "${name}" is v${major(rootDir)} at the repo root and ` +
            `v${major(desktopDir)} in desktop/. The desktop test project pins shared ` +
            `packages to the root copy so there is exactly one React in the process, ` +
            `which would silently test the wrong version here. Align the two package.json files.`
        );
      }
    }
    alias[name] = rootDir;
  }
  return alias;
}

// THREE test projects, one command (`npm test`), because CI already runs that one
// command and a second runner is a gate nobody remembers to add to the workflow.
//
//  • lib      — the original node project: PURE logic, no DOM, no network. Unchanged.
//  • web      — the Next.js components under jsdom.
//  • desktop  — the Electron renderer (desktop/src) under jsdom, resolved through the
//               SAME aliases desktop/vite.config.ts uses, so a test imports exactly
//               what the packaged app imports (shimmed supabase client included).
//
// Why the jsdom projects exist at all: every one of the 395 tests we had covered a
// pure function, and round 10's most common defect was a fix that COULD NOT EXECUTE
// — a parameter nothing passed, a guard whose only caller was never updated. Those
// ship green under pure-function tests because nothing ever traces from a real entry
// point to the added line. A component test is that trace.
const jsdomProject = (
  name: string,
  include: string[],
  alias: Record<string, string>,
  setupFiles: string[]
) => ({
  // dedupe is the belt for the alias pins below: it also covers react/jsx-runtime,
  // which the automatic JSX runtime injects into every transformed file.
  resolve: { alias, dedupe: ["react", "react-dom"] },
  // Root tsconfig says jsx:"preserve" (Next compiles it later) and vite's oxc
  // transformer honours that, so without this override every .tsx test dies at
  // parse with "Unexpected JSX expression". `oxc`, not `esbuild`: vite 8 / vitest 4
  // transform with rolldown-oxc and warn that esbuild options are being ignored.
  // `development: true` routes JSX through react/jsx-dev-runtime, which is what
  // gives a failed render a component name and a source line instead of a minified
  // stack — the difference between a five-minute and a fifty-minute debug.
  oxc: { jsx: { runtime: "automatic" as const, development: true } },
  test: {
    name,
    environment: "jsdom" as const,
    include,
    setupFiles,
    // jsdom leaks between files far more readily than node does (a module-level
    // listener, a cached client). One environment per file is worth the seconds.
    isolate: true,
  },
});

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { "@": repoRoot } },
        test: {
          name: "lib",
          environment: "node",
          include: ["lib/**/*.test.ts", "lib/**/*.test.tsx"],
          // `audio-store.dom.test.ts` ends in `.test.ts`, so it matches the include
          // above as well as the web project's — and a file collected by both runs
          // TWICE, once in an environment the name says it must not run in. Without
          // this the counts silently double and the whole `.dom.` convention below
          // means nothing.
          // `{ts,tsx}`, not `.ts`: a `lib/x.dom.test.tsx` matches the `.test.tsx`
          // include above, and a `.ts`-only exclude would leave it running HERE, in
          // node — the exact silent pass (asserting the storage-unavailable branch)
          // the `.dom.` convention exists to prevent.
          exclude: ["**/node_modules/**", "lib/**/*.dom.test.{ts,tsx}"],
        },
      },
      jsdomProject(
        "web",
        [
          "components/**/*.test.tsx",
          "app/**/*.test.tsx",
          // `{ts,tsx}` on both of the next two: a `test/web/*.test.ts` or a
          // `lib/*.dom.test.tsx` written against a `.tsx`-only / `.ts`-only glob is
          // collected by NO project and NO project reports it missing — it simply
          // never runs, and a suite that silently skips a file is worse than one
          // that never had it.
          "test/web/**/*.test.{ts,tsx}",
          // `lib/**/*.dom.test.{ts,tsx}` — the convention for lib modules that need a
          // BROWSER, not a DOM: audio-store, the outboxes and local-source all sit
          // on IndexedDB, which the node project does not have. Run there they would
          // quietly take their "storage unavailable" branch and the test would pass
          // while asserting the fallback. The `.dom.` marker keeps the node project
          // (`lib/**/*.test.ts`) fast and honest about what it covers.
          "lib/**/*.dom.test.{ts,tsx}",
        ],
        { "@": repoRoot },
        ["./test/setup/dom.ts"]
      ),
      jsdomProject(
        "desktop",
        // Desktop tests live under desktop/src ONLY. A `test/desktop/**` entry would
        // be a trap: root tsconfig excludes "desktop" but NOT "test", so a file there
        // is typechecked with ROOT paths — where "~/*" is not an alias at all and
        // "@/lib/supabase/client" resolves to the WEB cookie client while the test
        // RUNS against the localStorage shim. That exact divergence between what the
        // types say and what file:// actually loads is the bug that shipped to พี่.
        ["desktop/src/**/*.test.tsx", "desktop/src/**/*.test.ts"],
        {
          // ORDER MATTERS and mirrors desktop/vite.config.ts exactly: the two shim
          // entries must precede "@", because alias matching takes the first hit and
          // "@" also matches "@/lib/supabase/client".
          "@/lib/supabase/client": path.join(desktopSrc, "shims/supabase-client.ts"),
          "@/lib/count-samples": path.join(desktopSrc, "shims/count-samples.ts"),
          "@": repoRoot,
          "~": desktopSrc,
          "next/navigation": path.join(desktopSrc, "shims/next-navigation.tsx"),
          "next/link": path.join(desktopSrc, "shims/next-link.tsx"),
          "next/dynamic": path.join(desktopSrc, "shims/next-dynamic.tsx"),
          // Everything shared with the root install, pinned to the root copy — see
          // desktopDepsPinnedToRoot() above for why this is not optional. It is
          // spread LAST so a shim above always wins; none of the keys overlap today,
          // and this keeps that true if one ever does. react-router-dom is a root
          // devDependency purely to make this work, at the same 7.18.2 the app ships.
          ...desktopDepsPinnedToRoot(),
          react: path.join(repoRoot, "node_modules/react"),
          "react-dom": path.join(repoRoot, "node_modules/react-dom"),
          // react-router-dom's own dependency, reached from an aliased root copy but
          // named here too so a direct `import … from "react-router"` cannot slip
          // back to desktop's tree.
          "react-router": path.join(repoRoot, "node_modules/react-router"),
        },
        ["./test/setup/dom.ts", "./test/setup/desktop-env.ts"]
      ),
    ],
  },
});
