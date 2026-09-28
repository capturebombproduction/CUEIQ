"use client";

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isIOS, isStandalone } from "@/lib/platform";

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
 * To announce a later round: change ROUND and ITEMS. A new ROUND shows again on
 * every device; the old key is simply never read.
 */
const ROUND = "2026-09-28";
const KEY = "cueiq:whats-new-seen";

type Item = { text: string; only?: () => boolean };

const ITEMS: Item[] = [
  {
    text: "ก๊อปงาน: ใส่ชื่อ วันที่ และเวลาขึ้นเวทีได้ในหน้าเดียว — คิวทั้งวันเลื่อนตามให้เอง และรายชื่อคนมาติดมาด้วย",
  },
  { text: "Setlist: ปุ่ม “เติมให้พอดี” ข้างเวลารวม — แถวปิดท้ายพอดีช่วงขึ้นเวทีในแตะเดียว" },
  { text: "รูปสรุป: บอกว่ามากี่คน ขาดใคร และมีเวลาที่ส่งออกท้ายรูป (หลายรูปในกลุ่ม ให้ใช้รูปใหม่สุด)" },
  { text: "ห้องซ้อม: “ซ้อมตามเซ็ตลิสต์” — กดเล่นทั้งเซ็ต จบเพลงแล้วเล่นเพลงถัดไปเอง" },
  {
    text: "อยากให้แจ้งเตือนเด้งบน iPhone/iPad: ปุ่มแชร์ → “เพิ่มไปยังหน้าจอโฮม” แล้วเปิด CueIQ จากไอคอนนั้น",
    only: () => isIOS() && !isStandalone(),
  },
];

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === ROUND;
  } catch {
    return true; // storage refused → stay silent rather than nag every visit
  }
}

export function WhatsNew() {
  const [items, setItems] = useState<string[] | null>(null);

  // After mount only: the web dashboard is server-rendered, and both the storage
  // read and the platform probes need the browser.
  useEffect(() => {
    if (seen()) return;
    setItems(ITEMS.filter((i) => !i.only || i.only()).map((i) => i.text));
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, ROUND);
    } catch {
      /* closing anyway */
    }
    setItems(null);
  };

  if (!items) return null;
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
