"use client";

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canEditAnyGroup, canLiveEdit, canViewLibrary, type Perms } from "@/lib/permissions";

/**
 * "มีอะไรใหม่" — a short card on All Events, once per device per round of changes.
 *
 * Why it exists: this project's most repeated lesson is that a feature nobody is
 * told about does not exist. Autosave, the approval queue and the push switch
 * were each reported as "it doesn't work" while working. 2026-09-28 shipped a
 * day's worth of things the band will only benefit from if they know to look —
 * the copy dialog's stage time, the fill-to-fit button, the set run in practice.
 * พี่ asked for it to be said in the app, not only in the group chat.
 *
 * Same restraint as the push nudge: inline (never a modal over the page), gone for
 * good on "เข้าใจแล้ว", and SILENT when the browser will not remember — a card that
 * reappears on every visit is how people learn to ignore the next one.
 *
 * Only what the reader can use: an item about an editor's button is left out for
 * someone who will never see that button — telling a member about it invites the
 * very "it doesn't work" report this card exists to prevent. (The iPhone "add to
 * home screen" step is deliberately NOT here: PushNudge owns it, and knows to say
 * "open in Safari first" inside LINE, where that step does not exist.)
 *
 * To announce a later round: change ROUND and ITEMS. A new ROUND shows again on
 * every device; the old key is simply never read.
 */
// 2026-10-02: the redesign's round, shown once more to every device. The 10-01
// round (live on main) told phones sign-out was behind "⋯ มุมขวาบน" — the redesign
// removed that "⋯" AND the floating แจ้งปัญหา button, and a device that had closed the
// 10-01 card would never have been told either, because seen() compares the ROUND
// only. So: a new ROUND, with where everything went — the More tab below lg, the
// name button top right on a wide screen and in the desktop app, ⋯ on the two show
// screens. The older items stay below for anyone who never saw them.
// 2026-10-04 (v0.1.30 / v0.1.31): what changed for the people who run or watch a show -
// the first device is the show and every other device only watches (and follows its
// song, clock and levels), Live reads the Hard Out, a show left open for long comes
// back paused, and the desktop app's one-press update. The 10-02 items stay below.
const ROUND = "2026-10-04";
/** For tests that need "this device already read the current round". */
export const WHATS_NEW_ROUND = ROUND;
const KEY = "cueiq:whats-new-seen";
/** Fired when this round is marked read, so every surface that shows it (the card
 *  here, the More sheet's tile, the tab bar's dot) agrees without a reload. */
const SEEN_EVENT = "cueiq:whats-new-seen";

/**
 * Who is reading — what the round may say to THIS account. An item about a button
 * the reader will never see invites exactly the "it doesn't work" report this card
 * exists to prevent, so each item is tagged with the reader it is true for.
 *
 *  · canEdit            edits some band's shows (admin, or an Ar)
 *  · canLibrary         has the Library (not label staff, who work from Overview)
 *  · canPractice        has Training / the practice rooms, AND the home page's
 *                       banner — label staff have neither (the web sends them to
 *                       /overview, main-nav leaves Training out of their tabs)
 *  · seesPracticeButton the banner's "ซ้อมตามเซ็ต" button — everyone with a practice
 *                       room except an admin, whose second button is Live Mode
 *                       (canLiveEdit; components/event/events-list.tsx)
 */
export interface Reader {
  canEdit: boolean;
  canLibrary: boolean;
  canPractice: boolean;
  seesPracticeButton: boolean;
}

/** The old one-flag reader: no one is told less than before. For callers that only
 *  know `canEdit` (the desktop dashboard). */
const everyone = (canEdit: boolean): Reader => ({
  canEdit,
  canLibrary: true,
  canPractice: true,
  seesPracticeButton: true,
});

/** The Reader for an account, from the same rules the nav and the banner use.
 *  `canEdit` defaults to "edits some band" and can be given where the caller has
 *  already decided it (the layout and the dashboard each did, before this existed). */
export function readerFor(perms: Perms, canEdit = canEditAnyGroup(perms)): Reader {
  const canPractice = perms.tenantRole !== "label_staff";
  return {
    canEdit,
    canLibrary: canViewLibrary(perms),
    canPractice,
    seesPracticeButton: canPractice && !canLiveEdit(perms),
  };
}

type Item = { text: string; who?: (r: Reader) => boolean; only?: () => boolean };

const editors = (r: Reader) => r.canEdit;
/** People in a band - who open a show's Live screen (label staff work from Overview;
 *  canPractice is the same "not label staff" the nav uses). */
const bandPeople = (r: Reader) => r.canPractice;

/** The desktop app (its own update button), never a browser. */
const desktopApp = () => !!(window as unknown as { cueiqNative?: unknown }).cueiqNative;

/** The web below lg — where the bottom tab bar (and its More tab) exists. Not the
 *  desktop app (its own shell) and not a wide browser (the tools sit behind the
 *  header's avatar there). */
const phoneWeb = () =>
  !(window as unknown as { cueiqNative?: unknown }).cueiqNative &&
  window.matchMedia?.("(max-width: 1023px)").matches === true;

const ITEMS: Item[] = [
  {
    text: "Live: เครื่องที่กดเริ่มโชว์เป็นเครื่องเดียวที่คุมโชว์และมีเสียง — เครื่องที่เปิดตามมาดูได้อย่างเดียว เพลง เวลา และระดับเสียงตามเครื่องนั้น",
    who: bandPeople,
  },
  {
    text: "Live: แถบด้านบนบอก Hard Out ของงาน — เหลือก่อน Hard Out เท่าไหร่ และขึ้นเตือนเมื่อคาดว่าจะเกิน",
    who: bandPeople,
  },
  {
    text: "Live: โชว์ที่เปิดค้างไว้นานเกิน 10 นาที กลับมาแบบหยุดรอ — เพลงไม่ขึ้นเอง กดเล่นเมื่อพร้อม",
    who: bandPeople,
  },
  {
    text: "แอป CueIQ: กดปุ่มอัปเดตมุมขวาบนครั้งเดียว ได้เวอร์ชันล่าสุดเลย ไม่ต้องไล่กดทีละเวอร์ชัน",
    only: desktopApp,
  },
  {
    // 2026-10-01 said "⋯ มุมขวาบน"; the redesign moved these to the More tab, and a
    // card that points at a button that no longer exists is worse than no card.
    text: "หน้าตาใหม่: ธีม สีวง เปลี่ยนรหัสผ่าน ออกจากระบบ และ Feedback (แจ้งปัญหา) อยู่ในแท็บ “More” มุมขวาล่าง — ปุ่มแจ้งปัญหาที่ลอยมุมจอไม่มีแล้ว",
    only: phoneWeb,
  },
  {
    // A wide browser and the desktop app have no tab bar: the same tools sit behind
    // the account button (the user's initial) at the right of the header.
    text: "หน้าตาใหม่: ธีม สีวง เปลี่ยนรหัสผ่าน ออกจากระบบ และ Feedback (แจ้งปัญหา) อยู่ที่ปุ่มตัวอักษรชื่อคุณ มุมขวาบน — ปุ่มแจ้งปัญหาที่ลอยมุมจอไม่มีแล้ว",
    only: () => !phoneWeb(),
  },
  { text: "หน้า Live และคุมคิวงาน: แจ้งปัญหา ธีม และเต็มจอ อยู่ในปุ่ม “⋯” บนแถบด้านบน" },
  {
    text: "Live: เตือนเมื่อเหลือ 1 นาที และ 30 วินาที (รายการสั้นเตือนตามความยาว) — เกินเวลาการ์ดจะเปลี่ยนเป็นแผ่นลายเฉียงเหมือนกันทุกวง",
  },
  {
    text: "คลังเพลง: กด ▶ ฟังเพลงได้เลย มีแถบเล่นด้านล่าง — ออกจากหน้าคลังเพลงแล้วเสียงหยุดเอง",
    who: (r) => r.canLibrary,
  },
  {
    // The banner is on the home page, which label staff never reach (canPractice is
    // the same "not label staff" the nav uses for Training).
    text: "หน้าแรก: บอก “นัด” กับ “ขึ้นเวที” ของงานถัดไป",
    who: (r) => r.canPractice,
  },
  {
    // The button's real label — the bare “ซ้อม” was the banner's old wording. An admin's
    // second button is Live Mode, so for them this one does not exist.
    text: "หน้าแรก: ปุ่ม “ซ้อมตามเซ็ต” บนการ์ดงานถัดไป พาเข้าห้องซ้อมของวงในแตะเดียว",
    who: (r) => r.seesPracticeButton,
  },
  {
    text: "Setlist: ปุ่ม “เปลี่ยน” ข้างชื่อเพลง — สลับเป็นเพลงอื่นจากคลังได้ในที่เดิม ไมค์กับโน้ตคงไว้",
    who: editors,
  },
  {
    text: "ก๊อปงาน: ใส่ชื่อ วันที่ และเวลาขึ้นเวทีได้ในหน้าเดียว — คิวทั้งวันเลื่อนตามให้เอง",
    who: editors,
  },
  {
    text: "Setlist: ปุ่ม “เติมให้พอดี” ข้างเวลารวม — แถวปิดท้ายพอดีช่วงขึ้นเวทีในแตะเดียว",
    who: editors,
  },
  { text: "รูปสรุป: บอกว่ามากี่คน ขาดใคร และเวลาที่ส่งออก (หลายรูปในกลุ่ม ให้ใช้รูปใหม่สุด)" },
  {
    text: "ห้องซ้อม: “ซ้อมตามเซ็ตลิสต์” — กดเล่นทั้งเซ็ต จบเพลงแล้วเล่นเพลงถัดไปเอง",
    who: (r) => r.canPractice,
  },
];

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === ROUND;
  } catch {
    return true; // storage refused → stay silent rather than nag every visit
  }
}

/** This round's items for this reader — browser only (`only` reads the screen). */
export function whatsNewItems(reader: Reader): string[] {
  return ITEMS.filter((i) => (!i.who || i.who(reader)) && (!i.only || i.only())).map(
    (i) => i.text
  );
}

/** Mark this round read on this device, and tell every open surface. */
export function markWhatsNewSeen(): void {
  try {
    localStorage.setItem(KEY, ROUND);
  } catch {
    /* closing anyway */
  }
  window.dispatchEvent(new Event(SEEN_EVENT));
}

/**
 * True while this device has not read this round — the More tab's dot. Read after
 * mount (storage is browser-only) and kept current by markWhatsNewSeen, so reading
 * the card on the dashboard clears the dot without a reload. A device whose storage
 * refuses reads as "seen": a dot that can never be cleared is worse than none.
 */
export function useWhatsNewUnseen(): boolean {
  const [unseen, setUnseen] = useState(false);
  useEffect(() => {
    const update = () => setUnseen(!seen());
    update();
    window.addEventListener(SEEN_EVENT, update);
    return () => window.removeEventListener(SEEN_EVENT, update);
  }, []);
  return unseen;
}

/** `reader`: who is reading (see Reader) — build it with readerFor(). A caller that
 *  only knows `canEdit` (the desktop dashboard) may pass just that; it is told what
 *  it always was. */
export function WhatsNew(props: { canEdit: boolean } | { reader: Reader }) {
  const r = "reader" in props ? props.reader : everyone(props.canEdit);
  const { canEdit, canLibrary, canPractice, seesPracticeButton } = r;
  const [items, setItems] = useState<string[] | null>(null);

  // After mount only: the web dashboard is server-rendered, and the storage read
  // needs the browser.
  useEffect(() => {
    if (seen()) return;
    setItems(whatsNewItems({ canEdit, canLibrary, canPractice, seesPracticeButton }));
    // Read from the More sheet while this card is on screen → it goes too.
    const hide = () => setItems(null);
    window.addEventListener(SEEN_EVENT, hide);
    return () => window.removeEventListener(SEEN_EVENT, hide);
  }, [canEdit, canLibrary, canPractice, seesPracticeButton]);

  const dismiss = () => {
    markWhatsNewSeen();
    setItems(null);
  };

  if (!items || items.length === 0) return null;
  // A slab with an info-tone tile (spec §G.1), placed UNDER the next-show ticket by
  // the dashboard — never above the thing a member opened the app to see.
  return (
    <section data-testid="whats-new" aria-label="มีอะไรใหม่" className="slab p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid h-9 w-9 flex-none place-items-center rounded-[2px] bg-info/15 text-info-ink"
        >
          <Sparkles className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="h2 text-[22px]">What&apos;s New</h2>
          <p className="mt-1 text-[12.5px] text-muted-foreground">มีอะไรใหม่ใน CueIQ</p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
            {items.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <Button variant="secondary" className="mt-3" onClick={dismiss}>
            เข้าใจแล้ว
          </Button>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="ปิด"
          title="ปิด"
          className="-mr-2 -mt-2 grid h-11 w-11 shrink-0 place-items-center rounded-[2px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-[18px] w-[18px]" />
        </button>
      </div>
    </section>
  );
}
