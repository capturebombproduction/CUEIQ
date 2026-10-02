// Round 15 — the Dev Inbox on a touch iPad, and its reply bubble in a light band.
//  • CQ-36: the tabs and the error-toolbar buttons were `h-11 sm:h-9`, so a touch iPad
//    (768+) got 36–38px targets. The shrink now keys on the pointer, not the width.
//  • CQ-53: the answer bubble was a 12% band tint under a band-ink label. Ink is
//    tuned to the PAGE; the tint darkens what the label sits on, and the label fell to
//    4.42–4.49:1 for three presets (#8a7436, #e11d48, #ec4899). The tint is lighter now.
//    The contrast is computed from the real skin (lib/skin.ts) and the bubble's real
//    class, so it goes red if either the tint or the ink derivation drifts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { makeSupabaseFake, ok } from "@/test/fakes/supabase";
import { skinCss } from "@/lib/skin";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  fetchImageBlob: vi.fn(async () => new Blob(["x"], { type: "image/png" })),
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { DevInbox } from "@/components/admin/dev-inbox";

const AUTHOR = "33333333-3333-4333-8333-333333333333";
const report = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  user_id: AUTHOR,
  category: "bug",
  message: "ปุ่มเล็กเกินไปบน iPad",
  status: "open",
  context: null,
  created_at: "2026-08-15T10:00:00Z",
  reply: "แก้ให้แล้วครับ",
  replied_at: "2026-08-16T10:00:00Z",
  images: null,
  ...over,
});
const err = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "error",
  message: `boom ${id}`,
  stack: null,
  url: "https://cueiq-mu.vercel.app/events/abc",
  app_version: "deadbee",
  created_at: "2026-08-15T10:00:00Z",
  ...over,
});

function mount(errors: unknown[] = []) {
  h.supa = makeSupabaseFake({ script: { feedback: ok([report()]), client_errors: ok(errors) } });
  return render(
    <ConfirmProvider>
      <DevInbox namesById={{ [AUTHOR]: "ทิพย์" }} />
    </ConfirmProvider>
  );
}

const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("DevInbox — touch sizes (CQ-36)", () => {
  it("the Feedback / Errors tabs are 44px for a touch pointer, 38px only for a fine one", async () => {
    mount();
    await screen.findByText(/ปุ่มเล็กเกินไป/);
    const tabs = screen.getByRole("tablist");
    const c = classes(tabs);
    expect(c).toContain("[&>*]:h-11");
    expect(c).toContain("[@media(pointer:fine)]:[&>*]:h-[38px]");
    expect(c).not.toContain("sm:[&>*]:h-[38px]");
  });

  it("the error toolbar's buttons shrink on a fine pointer only", async () => {
    mount([err("e1"), err("e2", { url: "http://localhost:3000/x" })]);
    await screen.findByText(/ปุ่มเล็กเกินไป/);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /ปัญหา/ }), { button: 0 });
    const noiseToggle = await screen.findByRole("button", { name: /\+ noise 1/ });
    const clearNoise = screen.getByRole("button", { name: /ล้าง noise/ });
    const clearAll = screen.getByRole("button", { name: /ล้างทั้งหมด/ });
    expect(classes(noiseToggle)).toEqual(expect.arrayContaining(["min-h-11", "[@media(pointer:fine)]:min-h-0"]));
    for (const b of [clearNoise, clearAll]) {
      expect(classes(b)).toEqual(expect.arrayContaining(["h-11", "[@media(pointer:fine)]:h-9"]));
    }
    // and nothing in the inbox keys a size on sm: any more
    expect(document.querySelectorAll('[class*="sm:h-9"], [class*="sm:min-h-0"]')).toHaveLength(0);
  });
});

// ── CQ-53 ────────────────────────────────────────────────────────────────────

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
/** "h s% l%" → sRGB 0..1 */
function rgb(triplet: string): number[] {
  const [hh, ss, ll] = triplet.trim().split(/\s+/).map(parseFloat);
  const S = ss / 100;
  const L = ll / 100;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => {
    const k = (n + hh / 30) % 12;
    return L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const lightToken = (hex: string, name: string) =>
  skinCss(hex).split(".dark{")[0].match(new RegExp(`--${name}:([^;]+);`))![1];

describe("DevInbox — the reply bubble's label (CQ-53)", () => {
  // The three presets the audit measured under 4.5:1 with the old 12% tint.
  it.each(["#8a7436", "#e11d48", "#ec4899"])(
    "'ตอบไปแล้ว' in band ink is ≥ 4.5:1 on its bubble for %s (light, on a white card)",
    async (hex) => {
      mount();
      const label = await screen.findByText("ตอบไปแล้ว");
      const bubble = label.closest("div")!;
      const tint = classes(bubble).find((k) => /^bg-primary\/\[\.\d+\]$/.test(k));
      expect(tint, "the bubble is a band tint").toBeTruthy();
      const alpha = parseFloat(tint!.replace(/^bg-primary\/\[/, "").replace(/\]$/, ""));

      const primary = rgb(lightToken(hex, "primary"));
      const surface = primary.map((p) => p * alpha + (1 - alpha)); // over the white .slab card
      expect(ratio(rgb(lightToken(hex, "primary-ink")), surface)).toBeGreaterThanOrEqual(4.5);
    }
  );
});
