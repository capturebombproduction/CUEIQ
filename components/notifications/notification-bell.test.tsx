// The bell's panel, as a touch target. Its "อ่านทั้งหมด" was a 72 × 16 px text link
// on a phone — the only control in the restyled shell under 44 px, sitting right
// under the thumb that opened the bell. jsdom cannot measure, so this pins the
// height class that makes it 44 (h-11), and that the press still does its job.
//
// And as a keyboard widget: it is a plain popover, not a Radix dialog, so Esc, the
// ARIA state and "Tab leaves it" are all this file's own to keep.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard",
}));

import { NotificationBell } from "@/components/notifications/notification-bell";

const UNREAD = {
  id: "n1",
  type: "reminder",
  title: "โชว์พรุ่งนี้",
  body: null,
  link: null,
  read_at: null,
  created_at: "2026-10-01T10:00:00.000Z",
};

let supa: SupabaseFake;

beforeEach(() => {
  supa = makeSupabaseFake({
    script: {
      // first: the mount's load; then the mark-all update, which asks for its rows back
      notifications: [ok([UNREAD]), ok([{ id: "n1" }])],
      events: ok([]),
    },
  });
  h.supa = supa;
});
afterEach(() => cleanup());

async function openPanel() {
  await act(async () => {
    render(<NotificationBell userId="u1" tenantId="t1" />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /การแจ้งเตือน/ }));
  });
}

describe("NotificationBell panel", () => {
  it("อ่านทั้งหมด is a 44 px-tall target, and still marks everything read", async () => {
    await openPanel();
    const markAll = screen.getByRole("button", { name: /อ่านทั้งหมด/ });
    expect((markAll.getAttribute("class") ?? "").split(/\s+/)).toContain("h-11");
    await act(async () => {
      fireEvent.click(markAll);
    });
    // nothing unread is left, so the control goes with it
    expect(screen.queryByRole("button", { name: /อ่านทั้งหมด/ })).toBeNull();
  });

  // jsdom cannot lay anything out, so this pins the STRUCTURE that was measured in a
  // real browser at 844 x 390: the cap sits on the panel (it was a 56 px reserve on
  // the list alone, but header + footer are ~96 px, so the push footer ended 40 px
  // under the tab bar), and the list is what gives. The bottom edge itself is the
  // harness's to measure (run-bell.mjs: panel bottom <= tab-bar top).
  it("the PANEL stops above the phone's tab bar, and the list gives way inside it", async () => {
    await openPanel();
    const panel = (screen.getByTestId("notification-panel").getAttribute("class") ?? "").split(/\s+/);
    const cap = panel.find((k) => k.startsWith("max-h-[calc(")) ?? "";
    // a sideways phone: 60vh from below the header ran past the bar's top edge
    expect(cap).toContain("var(--tabbar-h");
    expect(cap).toContain("var(--bell-top");
    expect(cap).toContain("safe-area-inset-bottom");
    expect(panel).toEqual(expect.arrayContaining(["flex", "flex-col", "overflow-hidden"]));

    const list = (screen.getByTestId("notification-list").getAttribute("class") ?? "").split(/\s+/);
    expect(list).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "overflow-y-auto", "max-h-[60vh]"]));
    // the old 56 px reserve (which under-counted the header and footer) is gone
    expect(list.join(" ")).not.toContain("56px");

    // header and footer keep their height — only the list shrinks
    const header = screen.getByText("การแจ้งเตือน", { selector: "span.text-sm" }).parentElement!;
    expect(header.className).toContain("shrink-0");
    expect(screen.getByTestId("notification-list").nextElementSibling!.className).toContain("shrink-0");
  });
});

const trigger = () => screen.getByRole("button", { name: /การแจ้งเตือน/ });
const panelEl = () => screen.queryByTestId("notification-panel");

describe("NotificationBell panel — keyboard", () => {
  it("the trigger says what it controls and whether it is open; the panel is a labelled dialog", async () => {
    await act(async () => {
      render(<NotificationBell userId="u1" tenantId="t1" />);
    });
    expect(trigger()).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).not.toHaveAttribute("aria-controls");

    await act(async () => {
      fireEvent.click(trigger());
    });
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("dialog", { name: "การแจ้งเตือน" });
    expect(panel).toBe(panelEl());
    expect(trigger().getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.id).not.toBe("");
  });

  it("Esc closes the panel and puts focus back on the bell", async () => {
    await openPanel();
    expect(panelEl()).not.toBeNull();
    // a keyboard user opened it with Enter, so the bell had focus; then tabbed in
    screen.getByRole("button", { name: /อ่านทั้งหมด/ }).focus();
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    expect(panelEl()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("Esc with the panel closed does nothing — no listener left behind, no focus stolen", async () => {
    await openPanel();
    await act(async () => {
      fireEvent.click(trigger()); // toggle shut
    });
    expect(panelEl()).toBeNull();
    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    await act(async () => {
      fireEvent.keyDown(other, { key: "Escape" });
    });
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("another key does not close it", async () => {
    await openPanel();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Enter" });
    });
    expect(panelEl()).not.toBeNull();
  });

  it("Tab moving focus OUT of the bell closes the panel (it would otherwise walk into controls behind it)", async () => {
    await openPanel();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    await act(async () => {
      outside.focus();
    });
    expect(panelEl()).toBeNull();
    outside.remove();
  });

  it("focus moving between the bell and the panel's own controls keeps it open", async () => {
    await openPanel();
    await act(async () => {
      screen.getByRole("button", { name: /อ่านทั้งหมด/ }).focus();
    });
    expect(panelEl()).not.toBeNull();
    await act(async () => {
      trigger().focus();
    });
    expect(panelEl()).not.toBeNull();
  });
});

// The desktop app (2026-10-04) carries this same bell in its header. It has no push of its
// own (no service worker), and the web's "install to your home screen" read there as an
// instruction for the computer - so its footer says where push lives instead.
describe("NotificationBell · the push footer, web vs the desktop app", () => {
  const w = window as unknown as { cueiqNative?: unknown };
  afterEach(() => {
    delete w.cueiqNative;
  });

  it("on the web (no push here): install the app on the phone's home screen", async () => {
    await openPanel();
    expect(screen.getByTestId("notification-panel").textContent).toContain("ติดตั้งแอปลงหน้าจอโฮม (มือถือ)");
    expect(screen.getByTestId("notification-panel").textContent).not.toContain("แอปเดสก์ท็อป");
  });

  it("in the desktop app: this bell is the place, push is the phone's", async () => {
    w.cueiqNative = { isElectron: true };
    await openPanel();
    const text = screen.getByTestId("notification-panel").textContent ?? "";
    expect(text).toContain("ในแอปเดสก์ท็อป ดูได้ที่กระดิ่งนี้");
    expect(text).toContain("มือถือ");
  });
});
