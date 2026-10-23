import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// sonner keeps its toast store in module scope. The shared web components resolve
// "sonner" from the repo root and desktop/src resolves it from desktop/node_modules,
// so without dedupe the .exe bundled TWO copies (measured: 49 vs 25 toaster markers
// in dist/) and the one <Toaster> heard only its own copy — every toast a shared
// component fired (saved, failed, copied…) silently went nowhere.
//
// React the same way since Vite 8 / plugin-react 6, which stopped deduping it: two
// Reacts and every hook throws at boot. And lucide-react was bundled twice (review of
// 2026-10-23). The config now dedupes every runtime dependency in package.json.
describe("desktop vite config", () => {
  const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(desktopDir, "vite.config.ts"), "utf8");
  const deps = Object.keys(
    (JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8")) as { dependencies: Record<string, string> })
      .dependencies
  );

  it("dedupes every runtime dependency package.json lists", () => {
    expect(src).toMatch(/dedupe:\s*Object\.keys\(desktopPkg\.dependencies\)/);
    expect(src).toMatch(/const desktopPkg = createRequire\(import\.meta\.url\)\("\.\/package\.json"\)/);
  });

  it.each(["sonner", "react", "react-dom", "lucide-react", "react-router-dom"])(
    "…and %s is one of them, so the shared components and desktop/src share one copy",
    (name) => {
      expect(deps).toContain(name);
    }
  );
});
