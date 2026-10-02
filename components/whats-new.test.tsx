// "มีอะไรใหม่" — said once per device per round, never nagging. The restraint is
// what is pinned: gone for good after "เข้าใจแล้ว", back for a NEW round, silent
// when storage refuses, and editor-only items only for editors.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  WhatsNew,
  markWhatsNewSeen,
  readerFor,
  whatsNewItems,
  WHATS_NEW_ROUND,
  type Reader,
} from "./whats-new";
import { makePerms } from "@/lib/permissions";

const KEY = "cueiq:whats-new-seen";

beforeEach(() => {
  localStorage.clear();
});

const mount = async (canEdit = true) => {
  await act(async () => {
    render(<WhatsNew canEdit={canEdit} />);
  });
};

describe("WhatsNew", () => {
  it("tells a device that has not seen this round what changed", async () => {
    await mount();
    const card = screen.getByTestId("whats-new");
    expect(card).toHaveTextContent("ก๊อปงาน");
    expect(card).toHaveTextContent("ซ้อมตามเซ็ตลิสต์");
  });

  it("tells a PHONE where sign-out went — and only the web below lg, where the More tab exists", async () => {
    // 1023, not 639: the tab bar (and More) shows below lg, so a landscape phone or
    // a portrait iPad has it too. The old "⋯ top right" no longer exists anywhere.
    const mm = vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) => ({ matches: q.includes("max-width: 1023px"), media: q }) as MediaQueryList
    );
    await mount();
    expect(screen.getByTestId("whats-new")).toHaveTextContent("ออกจากระบบ");
    expect(screen.getByTestId("whats-new")).toHaveTextContent("“More”");
    expect(screen.getByTestId("whats-new")).not.toHaveTextContent("ปุ่มตัวอักษรชื่อคุณ");
    expect(screen.getByTestId("whats-new")).not.toHaveTextContent("⋯ มุมขวาบน");
    document.body.innerHTML = "";
    localStorage.clear();
    (window as unknown as { cueiqNative?: unknown }).cueiqNative = {}; // the desktop app
    await mount();
    expect(screen.getByTestId("whats-new")).not.toHaveTextContent("“More”");
    expect(screen.getByTestId("whats-new")).toHaveTextContent("ปุ่มตัวอักษรชื่อคุณ");
    delete (window as unknown as { cueiqNative?: unknown }).cueiqNative;
    mm.mockRestore();
  });

  it("a wide screen is pointed at the name button, never the More tab it does not have", async () => {
    await mount(); // the test DOM's matchMedia matches nothing — a wide screen
    const card = screen.getByTestId("whats-new");
    expect(card).not.toHaveTextContent("“More”");
    expect(card).toHaveTextContent("ออกจากระบบ");
    expect(card).toHaveTextContent("ปุ่มตัวอักษรชื่อคุณ มุมขวาบน");
  });

  // The redesign removed the floating แจ้งปัญหา button and the header's "⋯" that the
  // 10-01 card pointed phones at. 10-01 is live on main, so a device that closed it
  // holds "2026-10-01" — and was told nothing until the round moved on.
  it("comes back on a device that closed the 2026-10-01 round, and says where แจ้งปัญหา went", async () => {
    expect(WHATS_NEW_ROUND).not.toBe("2026-10-01");
    localStorage.setItem(KEY, "2026-10-01");
    await mount(false); // a member
    const card = screen.getByTestId("whats-new");
    expect(card).toHaveTextContent("Feedback (แจ้งปัญหา)");
    expect(card).toHaveTextContent("ปุ่มแจ้งปัญหาที่ลอยมุมจอไม่มีแล้ว");
    // …and on the two show screens, which have neither the tab bar nor the header
    expect(card).toHaveTextContent("หน้า Live และคุมคิวงาน");
  });

  it("comes back for the current round on a device that closed the 09-28 one", async () => {
    localStorage.setItem(KEY, "2026-09-28");
    await mount(false);
    // the banner's real label — "ซ้อมตามเซ็ต", not the bare "ซ้อม" it was once called
    expect(screen.getByTestId("whats-new")).toHaveTextContent("ปุ่ม “ซ้อมตามเซ็ต”");
  });

  it("goes for good on เข้าใจแล้ว — this round is remembered", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "เข้าใจแล้ว" }));
    expect(screen.queryByTestId("whats-new")).toBeNull();
    document.body.innerHTML = "";
    await mount();
    expect(screen.queryByTestId("whats-new")).toBeNull();
  });

  it("the X closes it for good too", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "ปิด" }));
    document.body.innerHTML = "";
    await mount();
    expect(screen.queryByTestId("whats-new")).toBeNull();
  });

  it("comes back for a NEW round on a device that closed an older one", async () => {
    localStorage.setItem(KEY, "2020-01-01"); // an earlier round, already read
    await mount();
    expect(screen.getByTestId("whats-new")).toBeInTheDocument();
  });

  it("stays silent when the browser refuses storage — never a card on every visit", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    await mount();
    expect(screen.queryByTestId("whats-new")).toBeNull();
    spy.mockRestore();
  });

  it("does not tell someone who cannot edit about editors' buttons", async () => {
    await mount(false);
    const card = screen.getByTestId("whats-new");
    expect(card).not.toHaveTextContent("ก๊อปงาน");
    expect(card).not.toHaveTextContent("เติมให้พอดี");
    expect(card).toHaveTextContent("ซ้อมตามเซ็ตลิสต์"); // members practise
  });
});

// The same round is also readable from the More sheet's What's New tile, and the
// More tab carries a dot until it is read. Read in either place, it is read
// everywhere — a card that stays up after the sheet showed it, or a dot that stays
// after the card was closed, would teach people to ignore both.
describe("WhatsNew — one round, read once, wherever it was read", () => {
  it("goes when the round is read from the More sheet, without a reload", async () => {
    await mount();
    expect(screen.getByTestId("whats-new")).toBeInTheDocument();
    act(() => markWhatsNewSeen());
    expect(screen.queryByTestId("whats-new")).toBeNull();
    expect(localStorage.getItem(KEY)).toBe(WHATS_NEW_ROUND);
  });

  it("closing the card tells the rest of the app (the More dot listens for this)", async () => {
    const heard = vi.fn();
    window.addEventListener("cueiq:whats-new-seen", heard);
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "เข้าใจแล้ว" }));
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener("cueiq:whats-new-seen", heard);
  });
});

// An item about a button the reader will never see invites the "it doesn't work"
// report this card exists to prevent. Each reader below is what readerFor() builds
// for that role (pinned separately), written out so the item rules read on their own.
const STAFF: Reader = { canEdit: false, canLibrary: false, canPractice: false, seesPracticeButton: false };
const ADMIN: Reader = { canEdit: true, canLibrary: true, canPractice: true, seesPracticeButton: false };
const MEMBER: Reader = { canEdit: false, canLibrary: true, canPractice: true, seesPracticeButton: true };

const LIBRARY = "คลังเพลง";
const BANNER = "หน้าแรก: บอก “นัด”";
const BANNER_BUTTON = "ปุ่ม “ซ้อมตามเซ็ต” บนการ์ดงานถัดไป";
const PRACTICE_ROOM = "ห้องซ้อม: “ซ้อมตามเซ็ตลิสต์”";
const has = (items: string[], part: string) => items.some((t) => t.includes(part));

describe("whatsNewItems — only what THIS reader can reach", () => {
  it("label staff are told nothing about the Library, the home banner or the practice room", () => {
    const items = whatsNewItems(STAFF);
    expect(has(items, LIBRARY)).toBe(false);
    expect(has(items, BANNER)).toBe(false);
    expect(has(items, BANNER_BUTTON)).toBe(false);
    expect(has(items, PRACTICE_ROOM)).toBe(false);
    // …and still hear what is theirs: where sign-out went.
    expect(has(items, "ออกจากระบบ")).toBe(true);
  });

  it("an admin is not told about the banner's practice button — theirs is Live Mode", () => {
    const items = whatsNewItems(ADMIN);
    expect(has(items, BANNER_BUTTON)).toBe(false);
    expect(has(items, "ปุ่ม “ซ้อม")).toBe(false); // under either wording
    // the rest of the home banner, the Library and the practice room are theirs
    expect(has(items, BANNER)).toBe(true);
    expect(has(items, LIBRARY)).toBe(true);
    expect(has(items, PRACTICE_ROOM)).toBe(true);
    expect(has(items, "ก๊อปงาน")).toBe(true); // editor items
  });

  it("a member is told about the banner button by its real name, ซ้อมตามเซ็ต", () => {
    const items = whatsNewItems(MEMBER);
    expect(has(items, BANNER_BUTTON)).toBe(true);
    expect(has(items, LIBRARY)).toBe(true);
    expect(has(items, PRACTICE_ROOM)).toBe(true);
    expect(has(items, "ก๊อปงาน")).toBe(false); // not an editor
    // nobody is pointed at a bare “ซ้อม” button — the banner has no such label
    expect(items.some((t) => t.includes("ปุ่ม “ซ้อม”"))).toBe(false);
  });

  it("an account with no band yet has no Library, so is not told about one", () => {
    expect(has(whatsNewItems({ ...MEMBER, canLibrary: false }), LIBRARY)).toBe(false);
  });

  it("the card itself follows the reader it is given", async () => {
    await act(async () => {
      render(<WhatsNew reader={STAFF} />);
    });
    const card = screen.getByTestId("whats-new");
    expect(card).not.toHaveTextContent(LIBRARY);
    expect(card).not.toHaveTextContent("ห้องซ้อม:");
    expect(card).toHaveTextContent("ออกจากระบบ");
  });

  it("a caller that only knows canEdit (the desktop dashboard) is told what it always was", async () => {
    await act(async () => {
      render(<WhatsNew canEdit={false} />);
    });
    const card = screen.getByTestId("whats-new");
    expect(card).toHaveTextContent(LIBRARY);
    expect(card).toHaveTextContent("ปุ่ม “ซ้อมตามเซ็ต”");
    expect(card).not.toHaveTextContent("ก๊อปงาน");
  });
});

describe("readerFor — the rules the nav and the banner already use", () => {
  const MEMBER_PERMS = makePerms("member", [{ group_id: "g1", role: "member" } as never]);
  const AR_PERMS = makePerms("member", [{ group_id: "g1", role: "artist_manager" } as never]);

  it("label_staff: no Library, no Training, no banner button, edits nothing", () => {
    expect(readerFor(makePerms("label_staff"))).toEqual(STAFF);
  });

  it("admin: everything, except the banner's practice button (canLiveEdit leads with Live Mode)", () => {
    expect(readerFor(makePerms("admin"))).toEqual(ADMIN);
  });

  it("ceo: sees the Library and the practice button, edits nothing", () => {
    expect(readerFor(makePerms("ceo"))).toEqual(MEMBER);
  });

  it("a band member sees the Library and the practice button; an Ar also edits", () => {
    expect(readerFor(MEMBER_PERMS)).toEqual(MEMBER);
    expect(readerFor(AR_PERMS)).toEqual({ ...MEMBER, canEdit: true });
  });

  it("a member with no band at all has no Library", () => {
    expect(readerFor(makePerms("member", [])).canLibrary).toBe(false);
  });

  it("a caller that has already decided canEdit hands it over", () => {
    expect(readerFor(makePerms("admin"), false).canEdit).toBe(false);
    expect(readerFor(MEMBER_PERMS, true).canEdit).toBe(true);
  });
});
