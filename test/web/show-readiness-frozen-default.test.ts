import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The one guard in show-readiness-check.tsx that NO behavioural test can defend.
//
// That card carries two guards against the render/refresh loop: useStableByContent
// and the frozen NO_LOCAL_ONLY default. Only the first is load-bearing — measured
// on the "must settle, not spin" block in components/event/show-readiness-check.
// test.tsx, removing useStableByContent turns a test red (11 passes), while putting
// `localOnly = []` back — the original bug, verbatim — leaves all 8 GREEN, because
// a fresh `[]` per render hashes to the same signature and gets the held array
// back. The two are behaviourally indistinguishable, so a runtime test CANNOT
// notice the constant going away; the next person to "simplify" it would see a full
// green suite and ship the source back to the shape the bug had.
//
// Hence a STRUCTURAL check. It cannot prove the loop is gone (the counter tests do
// that). It proves the belt is still buckled, which is the only claim left that
// nothing else can make.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../../components/event/show-readiness-check.tsx");

describe("ShowReadinessCheck keeps its frozen localOnly default", () => {
  const src = fs.readFileSync(SRC, "utf8");

  it("defaults `localOnly` to a module constant, never to an inline literal", () => {
    const m = /localOnly:\s*localOnlyProp\s*=\s*([^,\n]+)/.exec(src);
    expect(m, "the `localOnly` prop default is no longer where this test looks").not.toBeNull();
    expect(
      m![1].trim(),
      "a default parameter is re-evaluated on EVERY render: `= []` mints a new array " +
        "each time and is the original unbounded-loop bug. Default to the frozen " +
        "module constant instead."
    ).toBe("NO_LOCAL_ONLY");
  });

  it("keeps that constant frozen and allocated exactly once", () => {
    expect(
      /const NO_LOCAL_ONLY[^=]*=\s*Object\.freeze\(\[\]\)/.test(src),
      "NO_LOCAL_ONLY must stay a single frozen module-scope array — a `let`, a " +
        "factory call or an unfrozen literal reintroduces per-render identity churn"
    ).toBe(true);
  });
});
