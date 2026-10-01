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
// change people would otherwise report as missing (sign-out moved behind "⋯" on
// a phone). The 09-28 items stay below the new ones for anyone who never saw them.
const ROUND = "2026-10-01";
const KEY = "cueiq:whats-new-seen";

type Item = { text: string; editorsOnly?: boolean; only?: () => boolean };

/** The web on a phone-width screen — where the header's "⋯" exists. Not the
 *  desktop app (its own shell) and not a laptop browser (tools stay inline). */
const phoneWeb = () =>
  !(window as unknown as { cueiqNative?: unknown }).cueiqNative &&
  window.matchMedia?.("(max-width: 639px)").matches === true;

const ITEMS: Item[] = [
  { text: "หน้าแรก: บอก “นัด” กับ “ขึ้นเวที” ของงานถัดไป และปุ่ม “ซ้อม” พาเข้าห้องซ้อมของวงในแตะเดียว" },
  {
    text: "บนมือถือ: ธีม เปลี่ยนรหัสผ่าน และออกจากระบบ ย้ายไปอยู่ในปุ่ม “⋯” มุมขวาบน",
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

/** `canEdit`: this account can edit at least one band's shows — the editor-only
 *  items are about buttons that exist only for them. */
export function WhatsNew({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<string[] | null>(null);

  // After mount only: the web dashboard is server-rendered, and the storage read
  // needs the browser.
  useEffect(() => {
    if (seen()) return;
    setItems(
      ITEMS.filter((i) => (canEdit || !i.editorsOnly) && (!i.only || i.only())).map((i) => i.text)
    );
  }, [canEdit]);

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, ROUND);
    } catch {
      /* closing anyway */
    }
    setItems(null);
  };

  if (!items || items.length === 0) return null;
  return (
    <section
      data-testid="whats-new"
      aria-label="มีอะไรใหม่"
      className="rounded-xl border border-primary/40 bg-primary/5 p-4"
    >
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">มีอะไรใหม่ใน CueIQ</h2>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
            {items.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <Button size="sm" variant="outline" className="mt-3" onClick={dismiss}>
            เข้าใจแล้ว
          </Button>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="ปิด"
          title="ปิด"
          className="-mr-1.5 -mt-1.5 grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </section>
  );
}
