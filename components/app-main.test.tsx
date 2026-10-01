// The app's <main> on the two screens that run a show (FINAL-SPEC-v2 §F.4 / §G.10,
// critic finding X1). Those screens are edge to edge and own their own gutter: with
// the ordinary page padding left on <main>, Live's gutter doubled to 32 px, the
// overtime plate stopped 16 px short of the screen edge, the top bar sat 20 px down
// and the stage layout (exactly one screen tall) scrolled by the padding.
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

const nav = vi.hoisted(() => ({ path: "/dashboard" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));

import { AppMain } from "./app-main";

const PAGE =
  "container relative z-[1] overflow-x-clip pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+24px)] pt-5 lg:py-8";

function mainAt(path: string) {
  nav.path = path;
  const { container } = render(
    <AppMain className={PAGE}>
      <div data-testid="page" />
    </AppMain>
  );
  const main = container.querySelector("main");
  expect(main, "AppMain must render the page's one <main>").not.toBeNull();
  expect(main!.querySelector('[data-testid="page"]')).not.toBeNull();
  return main!.className.split(/\s+/);
}

describe("AppMain", () => {
  it.each(["/dashboard", "/events/e1", "/events/e1/run-order", "/events/e1/practice"])(
    "%s: the ordinary page frame, exactly as the layout passes it",
    (path) => {
      expect(mainAt(path).join(" ")).toBe(PAGE);
    }
  );

  it.each(["/events/e1/live", "/events/e1/run-order/live"])(
    "%s: no container, no padding, no tab-bar clearance — the screen owns its gutter",
    (path) => {
      const cls = mainAt(path);
      expect(cls).not.toContain("container");
      expect(cls.filter((c) => /(^|:)p[trblxy]?-/.test(c))).toEqual([]);
      // still a stacking box that never scrolls sideways (and never breaks sticky)
      expect(cls).toEqual(expect.arrayContaining(["relative", "z-[1]", "overflow-x-clip"]));
      expect(cls).not.toContain("overflow-hidden");
    }
  );
});
