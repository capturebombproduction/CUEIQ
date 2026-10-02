import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import { makeSupabaseFake, ok } from "@/test/fakes/supabase";

// ─────────────────────────────────────────────────────────────────────────────
// THE DESKTOP SHELL, AFTER THE REDESIGN (FINAL-SPEC-v2 §F.3 / §F.4).
//
// The desktop is the copy that goes to the venue, and it carried the same floating
// แจ้งปัญหา button as the web. Product decision (round 2): no floating feedback
// button anywhere. Reporting is the Feedback tile in the account panel, which the
// desktop opens from its header avatar (it has no tab bar). Also pinned: the
// immersive Live screens get no header, and the attributes the .exe self-test reads
// (data-cueiq-screen / data-cueiq-tenant) survive the new frame.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
// Its own subject (the offline outbox chips) with its own IndexedDB; a marker here.
vi.mock("~/components/mgmt-sync-status", () => ({
  MgmtSyncStatus: ({ headless }: { headless?: boolean }) => (
    <span data-testid="mgmt-sync" data-headless={headless ? "1" : "0"} />
  ),
}));
vi.mock("@/components/outbox-flusher", () => ({ OutboxFlusher: () => null }));

const PERMS = makePerms("member", [{ group_id: "g1", role: "member" } as never]);
const WS = {
  user: { id: "u1", email: "seishin-mem@cueiq.local", name: "มายด์" },
  membership: { tenant_id: "t1", role: "member" as const },
  tenant: { id: "t1", name: "A Lot Of Tone" },
  groups: [{ id: "g1", name: "Seishin Kakumei" }],
  groupRoles: [{ group_id: "g1", role: "member" }],
  perms: PERMS,
};
vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: WS, reload: () => {} }),
}));

import { Shell } from "./shell";
import { WHATS_NEW_ROUND } from "@/components/whats-new";

async function at(path: string) {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="*" element={<div data-testid="page" />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
  });
}

beforeEach(() => {
  h.supa = makeSupabaseFake({ script: { feedback: ok([]) } });
  localStorage.setItem("cueiq:whats-new-seen", WHATS_NEW_ROUND);
});

describe("desktop Shell — feedback", () => {
  it("renders NO floating feedback button — the page has nothing titled แจ้งปัญหา until the panel opens", async () => {
    await at("/dashboard");
    expect(screen.queryByTitle(/แจ้งปัญหา|มีคำตอบ/)).toBeNull();
    expect(screen.queryByText("แจ้งปัญหา")).toBeNull();
  });

  it("reports from the account panel, opened by the header avatar", async () => {
    await at("/dashboard");
    fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "เมนูบัญชี" }));
    const panel = screen.getByTestId("account-panel");
    expect(within(panel).getByTitle(/แจ้งปัญหา|มีคำตอบ/)).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "ออกจากระบบ" })).toBeTruthy();
    // The inline nav already lists the destinations; the panel does not repeat them.
    expect(within(panel).queryAllByRole("link")).toHaveLength(0);
  });
});

describe("desktop Shell — frame", () => {
  it("one header: wordmark, the inline nav, Quick Show, the account avatar — and no tab bar", async () => {
    await at("/dashboard");
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("link", { name: "CueIQ" })).toBeTruthy();
    expect(within(header).getByRole("navigation", { name: "เมนูหลัก" })).toBeTruthy();
    expect(within(header).getByRole("link", { name: /Quick Show/ })).toBeTruthy();
    expect(screen.queryByTestId("tab-bar")).toBeNull();
  });

  it("keeps the self-test's attributes on the frame", async () => {
    await at("/dashboard");
    const frame = document.querySelector('[data-cueiq-screen="shell"]');
    expect(frame?.getAttribute("data-cueiq-tenant")).toBe("A Lot Of Tone");
    expect(frame?.className).toContain("[--tabbar-h:0px]");
  });

  it.each(["/events/e1/live", "/events/e1/run-order/live"])(
    "%s is immersive: no header, the page still renders",
    async (path) => {
      await at(path);
      expect(screen.queryByRole("banner")).toBeNull();
      expect(screen.getByTestId("page")).toBeTruthy();
      expect(document.querySelector('[data-cueiq-screen="shell"]')).toBeTruthy();
    }
  );

  // MgmtSyncStatus is the ONLY thing that flushes the management outbox (boot + every
  // 'online'). It used to sit in a header present on every route; with the header
  // gone on the immersive screens, setlist/schedule edits queued offline stayed
  // unsynced for as long as Live or the caller stayed open. It stays mounted there,
  // headless (its own flush behaviour: mgmt-sync-status.test.tsx).
  it.each(["/events/e1/live", "/events/e1/run-order/live"])(
    "%s keeps the management outbox's auto-flush mounted, headless",
    async (path) => {
      await at(path);
      const marks = screen.getAllByTestId("mgmt-sync");
      expect(marks).toHaveLength(1);
      expect(marks[0]).toHaveAttribute("data-headless", "1");
    }
  );

  it("an ordinary page shows the outbox chips in the header (not headless)", async () => {
    await at("/dashboard");
    const marks = screen.getAllByTestId("mgmt-sync");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveAttribute("data-headless", "0");
    expect(within(screen.getByRole("banner")).getByTestId("mgmt-sync")).toBe(marks[0]);
  });

  // The show screens are edge to edge and own their gutter: with the page frame's
  // container + py-6 left on, Live's gutter doubled, the overtime plate stopped short
  // of the window edge and the stage layout (one window tall) scrolled.
  it.each(["/events/e1/live", "/events/e1/run-order/live"])(
    "%s: <main> drops the container and its padding",
    async (path) => {
      await at(path);
      const cls = document.querySelector("main")!.className.split(/\s+/);
      expect(cls).not.toContain("container");
      expect(cls.filter((c) => /(^|:)p[trblxy]?-/.test(c))).toEqual([]);
      expect(cls).toContain("overflow-x-clip");
    }
  );

  it("an ordinary page keeps the framed <main>", async () => {
    await at("/dashboard");
    expect(document.querySelector("main")!.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["container", "py-6", "overflow-x-clip"])
    );
  });
});

// v3 "Stage Wash" (FINAL-SPEC-v3 §E.11 / §F.4 desktop parity): the same page light
// the web frame hangs, in the same place — and none on the immersive screens, where
// Live Mode and the show-caller hang their own (one light per document).
describe("desktop Shell — the page light", () => {
  it("an ordinary page: ONE light, the frame's first element, the frame isolated", async () => {
    await at("/dashboard");
    const frame = document.querySelector('[data-cueiq-screen="shell"]')!;
    const lights = document.querySelectorAll(".spotlight");
    expect(lights).toHaveLength(1);
    expect(frame.firstElementChild).toBe(lights[0]);
    expect(lights[0]).toHaveAttribute("aria-hidden", "true");
    expect(frame.className.split(/\s+/)).toEqual(expect.arrayContaining(["relative", "isolate"]));
  });

  it("aims it at the left-aligned title from lg up, from the frame, as the web frame does", async () => {
    await at("/dashboard");
    const frame = document.querySelector('[data-cueiq-screen="shell"]')!;
    const cls = frame.className.split(/\s+/);
    expect(cls).toContain("lg:[--spot-x:25%]");
    expect(cls).toContain("lg:[&:has([data-stage-centred])]:[--spot-x:50%]");
    expect((document.querySelector(".spotlight") as HTMLElement).style.getPropertyValue("--spot-x")).toBe("");
  });

  it.each(["/events/e1/live", "/events/e1/run-order/live"])("%s: the frame hangs none", async (path) => {
    await at(path);
    expect(document.querySelectorAll(".spotlight")).toHaveLength(0);
  });
});

// A desktop window narrower than ~830 px: the nav row scrolls sideways, and a classic
// 15 px scrollbar (Windows draws one; macOS overlay scrollbars hide) appeared INSIDE
// the 56 px header — the pills sat 7 px high and the bar painted across them. The
// scroller hides its bar, and Quick Show sits OUTSIDE it as a sibling that never
// shrinks, so a narrow window scrolls the destinations and keeps Quick Show in reach.
// jsdom does not lay anything out: this pins the classes, and the measurement (scroller
// 44 px tall, pill centre on the header's centre at 800 and 683 px) is the browser
// harness's job.
describe("desktop Shell — the header's nav scroller in a narrow window", () => {
  const scroller = () =>
    within(screen.getByRole("banner")).getByRole("navigation", { name: "เมนูหลัก" }).parentElement!;

  it("scrolls sideways with its scrollbar hidden, in both engines' spellings", async () => {
    await at("/dashboard");
    const cls = scroller().className.split(/\s+/);
    expect(cls).toContain("overflow-x-auto");
    expect(cls).toContain("[scrollbar-width:none]");
    expect(cls).toContain("[&::-webkit-scrollbar]:hidden");
    // still the row's flexible part: it is what gives way when the window narrows
    expect(cls).toEqual(expect.arrayContaining(["min-w-0", "flex-1"]));
  });

  it("keeps Quick Show out of the scroller, as a sibling that never shrinks", async () => {
    await at("/dashboard");
    const link = within(screen.getByRole("banner")).getByRole("link", { name: /Quick Show/ });
    expect(scroller().contains(link)).toBe(false);
    expect(link.parentElement).toBe(scroller().parentElement);
    expect(link.className.split(/\s+/)).toContain("shrink-0");
    expect(scroller().nextElementSibling).toBe(link);
  });

  it("does not pin a min-width on the header row — the window itself decides", async () => {
    await at("/dashboard");
    const row = screen.getByRole("banner").firstElementChild!;
    expect(row.className).not.toMatch(/min-w-\[/);
    expect(scroller().className).not.toMatch(/(^|\s)min-w-\[/);
  });
});

// The Event page's tab row sticks at var(--header-h) under this header. The theme's
// 52px is the PHONE header; the desktop's row is h-14 (56px), so without its own
// value the tabs slid 4px under the glass — and the frame is where the web declares
// its lg value too (app/(app)/layout.tsx).
describe("desktop Shell — the header's height", () => {
  it("the frame declares the 56px its h-14 header row really is", async () => {
    await at("/dashboard");
    const frame = document.querySelector('[data-cueiq-screen="shell"]')!;
    expect(frame.className.split(/\s+/)).toContain("[--header-h:56px]");
    expect(screen.getByRole("banner").firstElementChild!.className.split(/\s+/)).toContain("h-14");
  });
});

// A RENDER CRASH ON THE SHOW SCREENS. The crash card's own control is a reload, and a
// reload keeps the hash — so a crash that comes from the data (a bad row in the cached
// bundle) comes straight back. Before the redesign the header above the card still had
// the nav and Quick Show; the immersive screens have no header, and the .exe has no
// back button, so without these the only way out was to quit the app mid-show.
function Boom(): never {
  throw new Error("live render exploded");
}

async function crashAt(path: string) {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="*" element={<Boom />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
  });
}

describe("desktop Shell — a crash on the show screens", () => {
  let quiet: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // React logs the caught error (and jsdom its unimplemented reload); expected here.
    quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    quiet.mockRestore();
    window.location.hash = "";
  });

  it.each(["/events/e1/live", "/events/e1/run-order/live"])(
    "%s: the crash card offers the way back to the event and Quick Show",
    async (path) => {
      await crashAt(path);
      expect(screen.getByText("เกิดข้อผิดพลาดบางอย่าง")).toBeInTheDocument();
      expect(screen.queryByRole("banner")).toBeNull();
      // Hash, then reload — as main.tsx's last-resort boundary does: this boundary is
      // not keyed by route, so an in-router navigate would leave the card standing.
      fireEvent.click(screen.getByRole("button", { name: /กลับไปหน้างาน/ }));
      expect(window.location.hash).toBe("#/events/e1");
      fireEvent.click(screen.getByRole("button", { name: /Quick Show/ }));
      expect(window.location.hash).toBe("#/my-show");
    }
  );

  it("an ordinary page's crash card adds nothing: the header above it keeps the nav and Quick Show", async () => {
    await crashAt("/dashboard");
    expect(screen.getByText("เกิดข้อผิดพลาดบางอย่าง")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Quick Show|กลับไปหน้างาน/ })).toBeNull();
    expect(within(screen.getByRole("banner")).getByRole("link", { name: /Quick Show/ })).toBeTruthy();
  });
});
