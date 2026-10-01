import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// sonner keeps its toast store in module scope. The shared web components resolve
// "sonner" from the repo root and desktop/src resolves it from desktop/node_modules,
// so without dedupe the .exe bundled TWO copies (measured: 49 vs 25 toaster markers
// in dist/) and the one <Toaster> heard only its own copy — every toast a shared
// component fired (saved, failed, copied…) silently went nowhere.
describe("desktop vite config", () => {
  it("dedupes sonner so shared components' toasts reach the one Toaster", () => {
    const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const src = readFileSync(join(desktopDir, "vite.config.ts"), "utf8");
    const dedupe = /dedupe:\s*\[([^\]]*)\]/.exec(src)?.[1] ?? "";
    expect(dedupe).toContain('"sonner"');
  });
});
