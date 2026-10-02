// The More sheet / account panel (redesign v2, FINAL-SPEC-v2 §F.3). It replaced
// two things at once: the header's "⋯" tray (theme, band colour, fullscreen,
// password, sign-out) and the floating แจ้งปัญหา button. What is pinned here:
//  · the invariant the tray carried — the bell and install are NEVER in here,
//    and every account tool IS (site-header.test.tsx pins the header's half);
//  · each tool is the real, working control, not a picture of one;
//  · Feedback and What's New are reachable, and their dots are explained inside;
//  · it opens from the More tab, closes on its own when the page changes, and is
//    mounted once.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import { makePerms } from "@/lib/permissions";
import { makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const nav = vi.hoisted(() => ({ path: "/dashboard", replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ replace: nav.replace, refresh: nav.refresh, push: vi.fn() }),
}));
const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/components/notifications/notification-bell", () => ({
  NotificationBell: () => <button type="button" aria-label="การแจ้งเตือน" />,
}));
vi.mock("@/components/install-button", () => ({
  InstallButton: () => <button type="button" aria-label="ติดตั้งแอป" />,
}));
vi.mock("@/components/notifications/push-cleanup", () => ({
  cleanupPushOnSignOut: async () => {},
}));

import { FeedbackUnreadProvider } from "@/components/feedback-button";
import { AccountPanel, AccountPanelProvider } from "@/components/account-panel";
import { SiteHeader } from "@/components/site-header";
import { TabBar } from "@/components/tab-bar";
import { ACCENT_PRESETS, ACCENT_STORAGE_KEY, SKIN_STYLE_ID } from "@/lib/accent";
import { WHATS_NEW_ROUND } from "@/components/whats-new";

const MEMBER = makePerms("member", [{ group_id: "g1", role: "member" } as never]);
const ADMIN = makePerms("admin");
const SEEN_KEY = "cueiq:whats-new-seen";

let supa: SupabaseFake;

function shell(perms = MEMBER) {
  return (
    <FeedbackUnreadProvider userId="u1">
      <AccountPanelProvider>
        <SiteHeader name="มายด์" perms={perms} userId="u1" tenantId="t1" />
        <TabBar perms={perms} />
        <AccountPanel
          name="มายด์"
          line="สมาชิก · Seishin Kakumei"
          perms={perms}
          userId="u1"
          tenantId="t1"
          canEdit={false}
        />
      </AccountPanelProvider>
    </FeedbackUnreadProvider>
  );
}

async function mount(perms = MEMBER) {
  let r!: ReturnType<typeof render>;
  await act(async () => {
    r = render(shell(perms));
  });
  return r;
}

const openMore = () => fireEvent.click(screen.getByRole("button", { name: "เมนูเพิ่มเติม" }));
const panel = () => screen.getByTestId("account-panel");

beforeEach(() => {
  nav.path = "/dashboard";
  nav.replace.mockClear();
  supa = makeSupabaseFake({ script: { feedback: ok([]) } });
  h.supa = supa;
  // This round already read on this device, unless a test says otherwise — so a
  // dot in a test means what that test set up.
  localStorage.setItem(SEEN_KEY, WHATS_NEW_ROUND);
  document.documentElement.classList.add("dark");
  // The panel only offers Fullscreen where the API exists (never on an iPhone).
  (document.documentElement as unknown as { requestFullscreen: unknown }).requestFullscreen =
    vi.fn(async () => {});
});
afterEach(() => {
  delete (document.documentElement as unknown as { requestFullscreen?: unknown }).requestFullscreen;
  document.getElementById(SKIN_STYLE_ID)?.remove();
  document.head.querySelector('meta[name="theme-color"]')?.remove();
});

describe("AccountPanel — what lives in it", () => {
  it("holds every account tool, and never the bell or install", async () => {
    await mount();
    openMore();
    const p = panel();
    expect(within(p).getByRole("radio", { name: /Dark/ })).toBeTruthy();
    expect(within(p).getByRole("radio", { name: /Light/ })).toBeTruthy();
    expect(within(p).getByRole("radiogroup", { name: "สีประจำวง" })).toBeTruthy();
    expect(within(p).getByRole("switch", { name: /Fullscreen/ })).toBeTruthy();
    expect(within(p).getByRole("button", { name: /Change password/ })).toBeTruthy();
    expect(within(p).getByTitle(/แจ้งปัญหา|มีคำตอบ/)).toBeTruthy(); // the Feedback tile
    expect(within(p).getByRole("button", { name: "ออกจากระบบ" })).toBeTruthy();

    for (const kept of ["การแจ้งเตือน", "ติดตั้งแอป"]) {
      expect(within(p).queryByRole("button", { name: kept })).toBeNull();
      // …they are still on screen, in the header.
      expect(screen.getByRole("button", { name: kept, hidden: true })).toBeTruthy();
    }
  });

  it("lists the destinations that did not earn a tab — Feedback as its tile, not a second link", async () => {
    await mount(MEMBER);
    openMore();
    const tiles = within(panel())
      .getAllByRole("link")
      .map((a) => [a.textContent?.match(/^[A-Za-z' ]+/)?.[0].trim(), a.getAttribute("href")]);
    expect(tiles).toEqual([
      ["Overview", "/overview"],
      ["Artists", "/groups"],
    ]);
    expect(within(panel()).getAllByTitle(/แจ้งปัญหา|มีคำตอบ/)).toHaveLength(1);
  });

  it("gives an admin the rest of the label's destinations", async () => {
    await mount(ADMIN);
    openMore();
    const hrefs = within(panel())
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/practice", "/groups", "/crew", "/admin"]);
  });

  it("says who is signed in, and carries the credit line", async () => {
    await mount();
    openMore();
    expect(panel()).toHaveTextContent("มายด์");
    expect(panel()).toHaveTextContent("สมาชิก · Seishin Kakumei");
    expect(panel()).toHaveTextContent("Designed by PatzNutthapat");
  });

  // The name is `disp truncate leading-none`: a clip box of +900/−100 units in a
  // Barlow-first stack, under Kanit's stacked tone marks (+1046) and ุ (−257) —
  // "พี่บุ๊ค" lost the mark on พี่ and the ุ. Padding widens the clip; the negative
  // margin gives the room back. jsdom has no layout: the room is what is pinned.
  it("the signed-in name keeps its Thai tone marks and lower vowels inside its clip", async () => {
    await mount();
    openMore();
    const name = within(panel()).getByText("มายด์");
    expect(name).toHaveClass("disp", "truncate", "py-[.25em]", "-my-[.25em]");
  });

  // viewport-fit=cover: the sheet is fixed and edge to edge, so the body's side
  // padding does not reach it — held sideways, its tiles sat under the notch.
  it("as a phone's bottom sheet, keeps its content inside a landscape iPhone's side insets", async () => {
    await mount();
    openMore();
    expect(panel()).toHaveClass(
      "fixed",
      "pl-[max(1rem,env(safe-area-inset-left))]",
      "pr-[max(1rem,env(safe-area-inset-right))]"
    );
    expect(panel()).not.toHaveClass("px-4");
  });

  it("holds each tool once — one panel, one sign-out", async () => {
    await mount();
    openMore();
    expect(screen.getAllByRole("button", { name: "ออกจากระบบ", hidden: true })).toHaveLength(1);
    expect(screen.getAllByTestId("account-panel")).toHaveLength(1);
  });
});

describe("AccountPanel — opening and closing", () => {
  it("opens from More; its close button shuts it", async () => {
    await mount();
    expect(screen.queryByTestId("account-panel")).toBeNull();
    openMore();
    expect(panel()).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: "ปิดเมนู" }));
    await waitFor(() => expect(screen.queryByTestId("account-panel")).toBeNull());
  });

  it("closes itself when the page changes (a destination tile was tapped)", async () => {
    const { rerender } = await mount();
    openMore();
    nav.path = "/groups";
    await act(async () => {
      rerender(shell());
    });
    expect(screen.queryByTestId("account-panel")).toBeNull();
  });
});

describe("AccountPanel — the tools are the real controls", () => {
  it("Dark | Light flips the theme, remembers it, and recolours the status bar", async () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = "#070708";
    document.head.appendChild(meta);
    await mount();
    openMore();
    fireEvent.click(within(panel()).getByRole("radio", { name: /Light/ }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("cueiq:theme")).toBe("light");
    expect(meta.content).toBe("#f1f1f3");
    expect(within(panel()).getByRole("radio", { name: /Light/ })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    fireEvent.click(within(panel()).getByRole("radio", { name: /Dark/ }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(meta.content).toBe("#070708");
  });

  it("a band-colour swatch reskins the app; the reset takes it back", async () => {
    await mount();
    openMore();
    fireEvent.click(within(panel()).getByRole("radio", { name: "Seishin Kakumei" }));
    expect(JSON.parse(localStorage.getItem(ACCENT_STORAGE_KEY)!).hex).toBe("#a62a1c");
    expect(document.getElementById(SKIN_STYLE_ID)?.textContent).toContain("--primary");
    fireEvent.click(within(panel()).getByRole("button", { name: "ค่าเริ่มต้น" }));
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBeNull();
  });

  // As a sideways-scrolling row it showed 6 of 11 at 390 px AND in the 380 px panel:
  // five colours and the custom picker sat off the edge with nothing saying so.
  // Wrapped, every one is on screen (measured in Chrome: two rows of 44 px at both
  // widths). jsdom cannot lay out, so this pins the layout that was measured.
  it("every band colour is on screen: the swatches wrap, never scroll sideways", async () => {
    await mount();
    openMore();
    const group = within(panel()).getByRole("radiogroup", { name: "สีประจำวง" });
    expect(within(group).getAllByRole("radio")).toHaveLength(ACCENT_PRESETS.length);
    expect(within(group).getByLabelText("เลือกสีแบบกำหนดเอง")).toBeInTheDocument();
    const cls = (group.getAttribute("class") ?? "").split(/\s+/);
    expect(cls).toContain("flex-wrap");
    expect(cls.filter((k) => /^overflow-(x-)?(auto|scroll)$/.test(k))).toEqual([]);
  });

  it("Change password hands over to the password dialog (which outlives the panel)", async () => {
    await mount();
    openMore();
    fireEvent.click(within(panel()).getByRole("button", { name: /Change password/ }));
    await waitFor(() => expect(screen.queryByTestId("account-panel")).toBeNull());
    expect(await screen.findByLabelText("รหัสผ่านปัจจุบัน")).toBeTruthy();
  });

  it("every open of the password dialog starts from empty fields", async () => {
    await mount();
    openMore();
    fireEvent.click(within(panel()).getByRole("button", { name: /Change password/ }));
    fireEvent.change(await screen.findByLabelText("รหัสผ่านปัจจุบัน"), {
      target: { value: "old-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ยกเลิก" }));
    await waitFor(() => expect(screen.queryByLabelText("รหัสผ่านปัจจุบัน")).toBeNull());
    openMore();
    fireEvent.click(within(panel()).getByRole("button", { name: /Change password/ }));
    expect(await screen.findByLabelText("รหัสผ่านปัจจุบัน")).toHaveValue("");
  });

  it("Fullscreen asks the browser for fullscreen", async () => {
    await mount();
    openMore();
    fireEvent.click(within(panel()).getByRole("switch", { name: /Fullscreen/ }));
    expect(document.documentElement.requestFullscreen).toHaveBeenCalled();
  });

  it("Sign out runs the real sign-out (neutral row, same guards as the button)", async () => {
    await mount();
    openMore();
    fireEvent.click(within(panel()).getByRole("button", { name: "ออกจากระบบ" }));
    await waitFor(() => expect(supa.auth.signOut).toHaveBeenCalled());
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/login"));
  });
});

describe("AccountPanel — Feedback and What's New, and the dots that point at them", () => {
  it("an answered report: dot on More, dot + words on the Feedback tile — and the testid once", async () => {
    supa.setTable("feedback", ok([{ id: "f1" }]));
    await mount();
    await waitFor(() => expect(screen.getByTestId("more-unread-dot")).toBeTruthy());
    openMore();
    const tile = within(panel()).getByTitle("มีคำตอบจากทีมงาน");
    expect(within(tile).getByTestId("feedback-unread-dot")).toBeTruthy();
    expect(tile).toHaveTextContent("มีคำตอบใหม่ 1");
    expect(screen.getAllByTestId("feedback-unread-dot")).toHaveLength(1);
  });

  it("an unread round of มีอะไรใหม่: dot on More and on its tile; opening it reads it", async () => {
    localStorage.removeItem(SEEN_KEY);
    await mount();
    expect(screen.getByTestId("more-unread-dot")).toBeTruthy();
    openMore();
    expect(within(panel()).getByTestId("whats-new-unseen-dot")).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: /What's New/ }));
    expect(within(panel()).getByTestId("whats-new-list")).toHaveTextContent("ซ้อมตามเซ็ตลิสต์");
    expect(localStorage.getItem(SEEN_KEY)).toBe(WHATS_NEW_ROUND);
    fireEvent.click(within(panel()).getByRole("button", { name: "เข้าใจแล้ว" }));
    expect(within(panel()).queryByTestId("whats-new-unseen-dot")).toBeNull();
    expect(screen.queryByTestId("more-unread-dot")).toBeNull();
  });

  // The floating แจ้งปัญหา button lived for the whole layout, so an unsent report
  // (and the offline toast's "ข้อความยังอยู่ในกล่อง") survived closing it and moving
  // between pages. The tile unmounts with this sheet — which also closes itself on
  // every page change — so the draft must live in the shell's provider, not the tile.
  it("an unsent report outlives the sheet: the text, category and screenshots come back", async () => {
    const urls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    Object.assign(URL, { createObjectURL: () => "blob:preview", revokeObjectURL: () => {} });
    try {
      const { rerender } = await mount();
      openMore();
      fireEvent.click(within(panel()).getByTitle(/แจ้งปัญหา|มีคำตอบ/));
      fireEvent.click(await screen.findByRole("button", { name: /ไอเดีย/ }));
      fireEvent.change(screen.getByLabelText("รายละเอียด"), {
        target: { value: "กด NEXT แล้วเพลงไม่เปลี่ยน" },
      });
      const shot = new File([new Uint8Array(10)], "shot.png", { type: "image/png" });
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [shot] },
      });
      expect(screen.getByAltText("shot.png")).toBeTruthy();

      // A tab tap: the page changes and the sheet (and the report dialog in it) closes.
      nav.path = "/groups";
      await act(async () => {
        rerender(shell());
      });
      await waitFor(() => expect(screen.queryByTestId("account-panel")).toBeNull());
      expect(screen.queryByLabelText("รายละเอียด")).toBeNull();

      openMore();
      fireEvent.click(within(panel()).getByTitle(/แจ้งปัญหา|มีคำตอบ/));
      expect(await screen.findByLabelText("รายละเอียด")).toHaveValue("กด NEXT แล้วเพลงไม่เปลี่ยน");
      expect(screen.getByRole("button", { name: /ไอเดีย/ })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByAltText("shot.png")).toBeTruthy();
    } finally {
      Object.assign(URL, { createObjectURL: urls.create, revokeObjectURL: urls.revoke });
    }
  });

  it("nothing waiting: no dot anywhere", async () => {
    await mount();
    expect(screen.queryByTestId("more-unread-dot")).toBeNull();
    openMore();
    expect(screen.queryByTestId("feedback-unread-dot")).toBeNull();
    expect(screen.queryByTestId("whats-new-unseen-dot")).toBeNull();
  });
});

// The sheet is opened from STATE (the More tab, the header avatar), so Radix has no
// Trigger to give focus back to and, before this, an Esc left focus on <body> — the
// next Tab started from the top of the page, behind a keyboard user's last position.
describe("AccountPanel — where focus goes when it closes", () => {
  const pressEscape = () =>
    fireEvent.keyDown(panel(), { key: "Escape", code: "Escape" });

  it("Esc closes it and puts focus back on the More tab that opened it", async () => {
    await mount();
    const more = screen.getByRole("button", { name: "เมนูเพิ่มเติม" });
    more.focus();
    fireEvent.click(more);
    expect(document.activeElement).not.toBe(more); // focus moved into the sheet
    pressEscape();
    await waitFor(() => expect(screen.queryByTestId("account-panel")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(more));
  });

  it("…and onto the header's avatar when the avatar opened it", async () => {
    await mount();
    const avatar = screen.getByRole("button", { name: /เมนูบัญชี/ });
    avatar.focus();
    fireEvent.click(avatar);
    pressEscape();
    await waitFor(() => expect(screen.queryByTestId("account-panel")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(avatar));
  });

  it("the close button gives it back too", async () => {
    await mount();
    const more = screen.getByRole("button", { name: "เมนูเพิ่มเติม" });
    more.focus();
    fireEvent.click(more);
    fireEvent.click(within(panel()).getByRole("button", { name: "ปิดเมนู" }));
    await waitFor(() => expect(screen.queryByTestId("account-panel")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(more));
  });

  it("handing over to the password dialog does NOT pull focus back to the More tab", async () => {
    await mount();
    const more = screen.getByRole("button", { name: "เมนูเพิ่มเติม" });
    more.focus();
    fireEvent.click(more);
    fireEvent.click(within(panel()).getByRole("button", { name: /Change password/ }));
    await waitFor(() => expect(screen.queryByTestId("account-panel")).toBeNull());
    expect(await screen.findByLabelText("รหัสผ่านปัจจุบัน")).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10)); // Radix returns focus on a timer
    });
    expect(document.activeElement).not.toBe(more);
  });
});

// jsdom has no layout: this pins the class that was measured in a real browser (the
// harness measures the edge itself). The header's container is centred and stops at
// 1280 px with a 1rem gutter; lg:right-4 pinned the panel 1rem from the VIEWPORT, so
// it hung 43 px past the avatar at 1366 and 80 px at 1440.
describe("AccountPanel — anchored to the avatar on a wide screen", () => {
  it("its right edge follows the centred 1280 px header, not the viewport", async () => {
    await mount();
    openMore();
    const cls = (panel().getAttribute("class") ?? "").split(/\s+/);
    expect(cls).toContain("lg:right-[max(1rem,calc((100%_-_1280px)/2_+_1rem))]");
    expect(cls).not.toContain("lg:right-4");
  });
});

// A round of "มีอะไรใหม่" that points at a button the reader cannot see invites the
// very "it doesn't work" report it exists to prevent: label staff have no Library, no
// Training and no home banner; an admin's banner has no practice button.
describe("AccountPanel — What's New is only about what this role can reach", () => {
  const STAFF = makePerms("label_staff");
  const MEMBER_BAND = makePerms("member", [{ group_id: "g1", role: "member" } as never]);

  async function readNews(perms: ReturnType<typeof makePerms>) {
    localStorage.removeItem(SEEN_KEY);
    await mount(perms);
    openMore();
    fireEvent.click(within(panel()).getByRole("button", { name: /What's New/ }));
    return within(panel()).getByTestId("whats-new-list");
  }

  it("label staff: no Library, no home banner, no practice room", async () => {
    const list = await readNews(STAFF);
    expect(list).not.toHaveTextContent("คลังเพลง");
    expect(list).not.toHaveTextContent("หน้าแรก");
    expect(list).not.toHaveTextContent("ห้องซ้อม");
    expect(list).toHaveTextContent("ออกจากระบบ"); // where sign-out went — theirs too
  });

  it("an admin: the banner's practice button is not theirs (their second button is Live Mode)", async () => {
    const list = await readNews(ADMIN);
    expect(list).not.toHaveTextContent("ปุ่ม “ซ้อม"); // under either wording of the button
    expect(list).toHaveTextContent("คลังเพลง");
    expect(list).toHaveTextContent("ห้องซ้อม");
  });

  it("a band member: told about the button by its real name", async () => {
    const list = await readNews(MEMBER_BAND);
    expect(list).toHaveTextContent("ปุ่ม “ซ้อมตามเซ็ต” บนการ์ดงานถัดไป");
    expect(list).not.toHaveTextContent("ปุ่ม “ซ้อม”");
    expect(list).toHaveTextContent("คลังเพลง");
  });
});
