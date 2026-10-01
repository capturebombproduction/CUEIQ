"use client";

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";

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
// 2026-10-01: a new round, shown once more to every device — it carries a
// change people would otherwise report as missing (sign-out moved off the phone
// header; since the redesign it lives in the More tab). The 09-28 items stay below
// the new ones for anyone who never saw them.
const ROUND = "2026-10-01";
const KEY = "cueiq:whats-new-seen";
/** Fired when this round is marked read, so every surface that shows it (the card
 *  here, the More sheet's tile, the tab bar's dot) agrees without a reload. */
const SEEN_EVENT = "cueiq:whats-new-seen";

type Item = { text: string; editorsOnly?: boolean; only?: () => boolean };

/** The web below lg — where the bottom tab bar (and its More tab) exists. Not the
 *  desktop app (its own shell) and not a wide browser (the tools sit behind the
 *  header's avatar there). */
const phoneWeb = () =>
  !(window as unknown as { cueiqNative?: unknown }).cueiqNative &&
  window.matchMedia?.("(max-width: 1023px)").matches === true;

const ITEMS: Item[] = [
  { text: "หน้าแรก: บอก “นัด” กับ “ขึ้นเวที” ของงานถัดไป และปุ่ม “ซ้อม” พาเข้าห้องซ้อมของวงในแตะเดียว" },
  {
    // 2026-10-01 said "⋯ มุมขวาบน"; the redesign moved these to the More tab, and a
    // card that points at a button that no longer exists is worse than no card.
    text: "บนมือถือ: ธีม สีวง เปลี่ยนรหัสผ่าน และออกจากระบบ อยู่ในแท็บ “More” มุมขวาล่าง",
    only: phoneWeb,
  },
  {
    text: "Setlist: ปุ่ม “เปลี่ยน” ข้างชื่อเพลง — สลับเป็นเพลงอื่นจากคลังได้ในที่เดิม ไมค์กับโน้ตคงไว้",
    editorsOnly: true,
  },
  {
    text: "ก๊อปงาน: ใส่ชื่อ วันที่ และเวลาขึ้นเวทีได้ในหน้าเดียว — คิวทั้งวันเลื่อนตามให้เอง",
    editorsOnly: true,
  },
  {
    text: "Setlist: ปุ่ม “เติมให้พอดี” ข้างเวลารวม — แถวปิดท้ายพอดีช่วงขึ้นเวทีในแตะเดียว",
    editorsOnly: true,
  },
  { text: "รูปสรุป: บอกว่ามากี่คน ขาดใคร และเวลาที่ส่งออก (หลายรูปในกลุ่ม ให้ใช้รูปใหม่สุด)" },
  { text: "ห้องซ้อม: “ซ้อมตามเซ็ตลิสต์” — กดเล่นทั้งเซ็ต จบเพลงแล้วเล่นเพลงถัดไปเอง" },
];

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === ROUND;
  } catch {
    return true; // storage refused → stay silent rather than nag every visit
  }
}

/** This round's items for this account — browser only (`only` reads the screen). */
export function whatsNewItems(canEdit: boolean): string[] {
  return ITEMS.filter((i) => (canEdit || !i.editorsOnly) && (!i.only || i.only())).map(
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

/** `canEdit`: this account can edit at least one band's shows — the editor-only
 *  items are about buttons that exist only for them. */
export function WhatsNew({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<string[] | null>(null);

  // After mount only: the web dashboard is server-rendered, and the storage read
  // needs the browser.
  useEffect(() => {
    if (seen()) return;
    setItems(whatsNewItems(canEdit));
    // Read from the More sheet while this card is on screen → it goes too.
    const hide = () => setItems(null);
    window.addEventListener(SEEN_EVENT, hide);
    return () => window.removeEventListener(SEEN_EVENT, hide);
  }, [canEdit]);

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
