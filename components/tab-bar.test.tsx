// The phone's bottom tab bar (FINAL-SPEC-v2 §F.2). bottomTabsFor/activeTabHref are
// pinned by main-nav.test.tsx; what is pinned HERE is that the bar actually renders
// them: the right three tabs per role, the right one lit, More opening the sheet,
// the dot, and the screens where there must be no bar at all.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { makePerms, type Perms } from "@/lib/permissions";
import { makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const nav = vi.hoisted(() => ({ path: "/dashboard" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));
const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { TabBar } from "./tab-bar";
import { AccountPanelProvider } from "./account-panel";
import { FeedbackUnreadProvider } from "./feedback-button";
import { WHATS_NEW_ROUND } from "./whats-new";

const MEMBER = makePerms("member", [{ group_id: "g1", role: "member" } as never]);
const AR = makePerms("member", [{ group_id: "g1", role: "artist_manager" } as never]);
const ADMIN = makePerms("admin");
const CEO = makePerms("ceo");
const STAFF = makePerms("label_staff");

let supa: SupabaseFake;

const bar = () => screen.getByTestId("tab-bar");
/** The bar's four slots, in order (links and the More button alike). */
const slots = () => Array.from(bar().querySelectorAll<HTMLElement>(":scope > div > a, :scope > div > button"));
const tabs = () => slots().map((el) => [el.textContent, el.getAttribute("href")]);

async function mount(perms: Perms = MEMBER) {
  let r!: ReturnType<typeof render>;
  const ui = () => (
    <FeedbackUnreadProvider userId="u1">
      <AccountPanelProvider>
        <TabBar perms={perms} />
      </AccountPanelProvider>
    </FeedbackUnreadProvider>
  );
  await act(async () => {
    r = render(ui());
  });
  return { ...r, again: () => act(async () => void r.rerender(ui())) };
}

beforeEach(() => {
  nav.path = "/dashboard";
  supa = makeSupabaseFake({ script: { feedback: ok([]) } });
  h.supa = supa;
  localStorage.setItem("cueiq:whats-new-seen", WHATS_NEW_ROUND);
});
afterEach(() => {
  document.documentElement.style.removeProperty("--tabbar-h");
});

describe("TabBar — three tabs + More, by who is holding the phone", () => {
  it.each([
    ["member", MEMBER],
    ["Ar", AR],
  ])("%s: Events · Training · Library · More", async (_, perms) => {
    await mount(perms);
    expect(tabs()).toEqual([
      ["Events", "/dashboard"],
      ["Training", "/practice"],
      ["Library", "/library"],
      ["More", null],
    ]);
  });

  it.each([
    ["admin", ADMIN],
    ["ceo", CEO],
  ])("%s: Events · Overview · Library · More", async (_, perms) => {
    await mount(perms);
    expect(tabs()).toEqual([
      ["Events", "/dashboard"],
      ["Overview", "/overview"],
      ["Library", "/library"],
      ["More", null],
    ]);
  });

  it("label staff: Overview · Artists · Crew · More", async () => {
    await mount(STAFF);
    expect(tabs()).toEqual([
      ["Overview", "/overview"],
      ["Artists", "/groups"],
      ["Crew", "/crew"],
      ["More", null],
    ]);
  });

  it("is the phone's bar only: glass, fixed to the bottom, hidden from lg up", async () => {
    await mount();
    const cls = bar().className.split(/\s+/);
    for (const c of ["glass", "glass-bottom", "fixed", "bottom-0", "lg:hidden", "pb-[env(safe-area-inset-bottom)]"]) {
      expect(cls).toContain(c);
    }
  });
});

describe("TabBar — which tab is lit", () => {
  const lit = () =>
    slots()
      .filter((el) => el.getAttribute("aria-current") === "page")
      .map((el) => el.textContent);

  it("a show page lights Events; its practice room lights Training", async () => {
    nav.path = "/events/e1";
    const m = await mount();
    expect(lit()).toEqual(["Events"]);
    nav.path = "/events/e1/practice";
    await m.again();
    expect(lit()).toEqual(["Training"]);
  });

  it("a page that lives in the More sheet lights More", async () => {
    nav.path = "/admin";
    await mount(ADMIN);
    expect(lit()).toEqual(["More"]);
  });
});

describe("TabBar — More", () => {
  it("opens and closes the sheet, saying which it will do", async () => {
    await mount();
    const more = screen.getByRole("button", { name: "เมนูเพิ่มเติม" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-label", "ปิดเมนู");
    expect(more).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-label", "เมนูเพิ่มเติม");
  });

  it("carries a dot when an answer to a report is waiting", async () => {
    supa.setTable("feedback", ok([{ id: "f1" }]));
    await mount();
    expect(within(bar()).getByTestId("more-unread-dot")).toBeTruthy();
  });

  it("carries a dot for a round of มีอะไรใหม่ this device has not read", async () => {
    localStorage.removeItem("cueiq:whats-new-seen");
    await mount();
    expect(within(bar()).getByTestId("more-unread-dot")).toBeTruthy();
  });

  it("no dot when nothing is waiting", async () => {
    await mount();
    expect(within(bar()).queryByTestId("more-unread-dot")).toBeNull();
  });
});

describe("TabBar — where there is no bar", () => {
  it.each(["/events/e1/live", "/events/e1/run-order/live"])(
    "%s is immersive: no bar, and nothing keeps room for one",
    async (path) => {
      nav.path = path;
      await mount();
      expect(screen.queryByTestId("tab-bar")).toBeNull();
      expect(document.documentElement.style.getPropertyValue("--tabbar-h")).toBe("0px");
    }
  );

  it("the running-order BUILDER is an ordinary page with the bar", async () => {
    nav.path = "/events/e1/run-order";
    await mount();
    expect(bar()).toBeTruthy();
    expect(document.documentElement.style.getPropertyValue("--tabbar-h")).toBe("");
  });

  it("leaving Live gives the bar its room back", async () => {
    nav.path = "/events/e1/live";
    const m = await mount();
    nav.path = "/events/e1";
    await m.again();
    expect(bar()).toBeTruthy();
    expect(document.documentElement.style.getPropertyValue("--tabbar-h")).toBe("");
  });
});

describe("TabBar — the soft keyboard", () => {
  const touch = () =>
    vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) => ({ matches: q.includes("pointer: coarse"), media: q }) as MediaQueryList
    );

  it("slides away while a touch device types into a field, and comes back after", async () => {
    const mm = touch();
    await mount();
    const field = document.createElement("input");
    document.body.appendChild(field);
    act(() => field.focus());
    expect(bar().className).toContain("translate-y-full");
    act(() => field.blur());
    expect(bar().className).not.toContain("translate-y-full");
    field.remove();
    mm.mockRestore();
  });

  it("comes back when Android's Back key closes the keyboard but the field keeps focus", async () => {
    const mm = touch();
    // a visual viewport that the test can shrink and grow like a real keyboard does
    const listeners = new Set<() => void>();
    const vv = {
      height: 844,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    const prev = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    const resize = (h: number) =>
      act(() => {
        vv.height = h;
        listeners.forEach((fn) => fn());
      });
    try {
      await mount();
      const field = document.createElement("input");
      document.body.appendChild(field);
      act(() => field.focus());
      resize(480); // the keyboard comes up
      expect(bar().className).toContain("translate-y-full");
      resize(844); // Back closes it; the field is still focused, no focusout
      expect(document.activeElement).toBe(field);
      expect(bar().className).not.toContain("translate-y-full");
      field.remove();
    } finally {
      if (prev) Object.defineProperty(window, "visualViewport", prev);
      else delete (window as unknown as { visualViewport?: unknown }).visualViewport;
      mm.mockRestore();
    }
  });

  it("stays for a control that raises no keyboard (a checkbox)", async () => {
    const mm = touch();
    await mount();
    const box = document.createElement("input");
    box.type = "checkbox";
    document.body.appendChild(box);
    act(() => box.focus());
    expect(bar().className).not.toContain("translate-y-full");
    box.remove();
    mm.mockRestore();
  });

  it("stays on a mouse-and-keyboard browser, whose keyboard covers nothing", async () => {
    await mount(); // the test DOM's matchMedia matches nothing — a fine pointer
    const field = document.createElement("input");
    document.body.appendChild(field);
    act(() => field.focus());
    expect(bar().className).not.toContain("translate-y-full");
    field.remove();
  });
});
