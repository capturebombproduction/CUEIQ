// The root layout's share of the shell (FINAL-SPEC-v2 §F.4): the viewport reaches
// under the notch, the status bar follows the theme from the first paint, toasts
// sit under the header, and a saved band colour is refreshed on every page.
import { describe, it, expect, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

vi.mock("next/font/google", () => ({
  Kanit: () => ({ variable: "font-kanit" }),
  Barlow_Condensed: () => ({ variable: "font-barlow" }),
}));

import RootLayout, { viewport } from "@/app/layout";
import manifestFor from "@/app/manifest";
import { Toaster } from "@/components/ui/sonner";
import { SkinRefresher } from "@/components/skin-refresher";
import { THEME_COLOR } from "@/lib/theme-mode";

type El = ReactElement<Record<string, unknown>>;
function all(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => all(n, out));
  else if (isValidElement(node)) {
    out.push(node as El);
    for (const v of Object.values((node as El).props ?? {})) all(v, out);
  }
  return out;
}
const tree = () => all(RootLayout({ children: <div /> }));

describe("root layout — viewport", () => {
  it("covers the whole screen, so the safe-area insets are real numbers", () => {
    expect(viewport.viewportFit).toBe("cover");
  });

  it("starts the status bar on the dark page colour (dark is the default)", () => {
    expect(viewport.themeColor).toBe(THEME_COLOR.dark);
  });

  it("switches the status bar to the light colour before first paint on a light device", () => {
    const script = tree().find((e) => e.type === "script")!;
    const js = (script.props.dangerouslySetInnerHTML as { __html: string }).__html;
    expect(js).toContain('meta[name="theme-color"]');
    expect(js).toContain(THEME_COLOR.light);
    expect(js).toContain("'cueiq:theme'");
  });
});

describe("root layout — always-mounted pieces", () => {
  it("refreshes a saved band colour on every page", () => {
    expect(tree().filter((e) => e.type === SkinRefresher)).toHaveLength(1);
  });

  it("mounts the Toaster bare: no pastel richColors, no second opinion on placement", () => {
    // Placement under the header and the rail styling are the primitive's
    // (components/ui/sonner.tsx). A prop here would silently override them.
    const toaster = tree().find((e) => e.type === Toaster)!;
    expect(toaster.props.richColors).toBeUndefined();
    expect(toaster.props.position).toBeUndefined();
    expect(toaster.props.offset).toBeUndefined();
  });
});

describe("web app manifest", () => {
  it("boots an installed app on the dark page colour, not a white flash", () => {
    const m = manifestFor();
    expect(m.background_color).toBe(THEME_COLOR.dark);
    expect(m.theme_color).toBe(THEME_COLOR.dark);
  });

  it("offers a maskable icon, and keeps the plain ones", () => {
    const icons = manifestFor().icons ?? [];
    expect(icons.some((i) => i.purpose === "maskable" && i.sizes === "512x512")).toBe(true);
    expect(icons.filter((i) => i.purpose === "any").map((i) => i.sizes)).toEqual([
      "192x192",
      "512x512",
    ]);
  });
});
