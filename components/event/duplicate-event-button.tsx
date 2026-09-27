"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { cloneEvent } from "@/lib/clone-event";
import { shortClock } from "@/lib/time";
import { reportClone } from "@/components/event/clone-outcome";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

// Idol groups run the same show again and again — Seishin Kakumei enters about
// two a week, and each one is the last one with the date, the name, a few times
// and a couple of songs changed. So this is the most-used way a show gets made,
// and it asks for the things that ALWAYS change (name, date, and the stage time —
// which moves the whole day with it, see lib/clone-event.ts) up front instead of
// opening a "… (สำเนา)" with no date that then has to be edited. Schedule,
// setlist, mic map and lineup all come across (lib/clone-event.ts); audio bytes
// never do.

/** "+2:00" / "−0:30" — how far the day moved, for the toast. */
function fmtShift(sec: number): string {
  const m = Math.abs(Math.round(sec / 60));
  return `${sec < 0 ? "−" : "+"}${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

export function DuplicateEventButton({
  eventId,
  eventName,
  showStartTime,
}: {
  eventId: string;
  eventName: string;
  /** The source's show start ("HH:MM:SS") — shown as "เดิม …" beside the new one. */
  showStartTime?: string | null;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [stageStart, setStageStart] = useState("");

  async function duplicate() {
    if (busy) return;
    setBusy(true);
    const supabase = createClient();
    const finalName = name.trim() || `${eventName} (สำเนา)`;
    try {
      const result = await cloneEvent(supabase, {
        sourceId: eventId,
        sourceLabel: "งานต้นฉบับ",
        buildEvent: (ev) => ({
          tenant_id: ev.tenant_id,
          group_id: ev.group_id,
          name: finalName,
          event_type: ev.event_type,
          venue: ev.venue,
          show_start_time: ev.show_start_time,
          hard_out_time: ev.hard_out_time,
          notes: ev.notes,
          map_url: ev.map_url,
          costume_theme: ev.costume_theme,
          status: "draft",
          event_date: date || null,
        }),
        stageStart: stageStart || undefined,
      });
      const success =
        result.shiftedBy === null
          ? "ก๊อปงานเรียบร้อย — แต่งานต้นฉบับไม่มีเวลาขึ้นเวที เลยยังไม่ได้เลื่อนคิว"
          : result.shiftedBy
          ? `ก๊อปงานเรียบร้อย — เลื่อนคิวทั้งวัน ${fmtShift(result.shiftedBy)} แล้ว (เช็คเวลาบูธอีกที)`
          : "ก๊อปงานเรียบร้อย — เปิดงานใหม่ให้แล้ว";
      const opened = await reportClone(result, {
        name: finalName,
        supabase,
        confirm,
        open: (id) => router.push(`/events/${id}`),
        text: {
          success,
          failed: "ก๊อปงานไม่สำเร็จ",
          partial: "ก๊อปงานสำเร็จบางส่วน",
        },
      });
      if (!opened) setBusy(false);
    } catch (err) {
      toast.error("ก๊อปงานไม่สำเร็จ", {
        description: err instanceof Error ? err.message : undefined,
      });
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={(e) => {
          e.preventDefault(); // the card is a <Link> — don't navigate
          e.stopPropagation();
          setOpen(true);
        }}
        disabled={busy}
        aria-label={`ก๊อปงาน ${eventName} เป็นงานใหม่`}
        title="ก๊อปงานนี้เป็นงานใหม่ (รวมคิว / เซ็ตลิสต์ / ไมค์ / รายชื่อคนมา — ไม่รวมไฟล์เพลง)"
        // Was `opacity-0 group-hover:opacity-100`: a touch device never hovers, so
        // this control was permanently invisible on the iPads the bands use — and
        // still tappable, sitting over the bottom-right corner of a card that is
        // itself a link. Reveal-on-hover only where hover exists; everywhere else it
        // is simply visible.
        className="absolute bottom-2 right-2 z-10 flex h-9 w-9 items-center justify-center rounded-md border bg-background/80 text-muted-foreground shadow-sm backdrop-blur transition hover:text-primary focus:opacity-100 disabled:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
      </button>
      {/* The dialog renders in a portal, but React still bubbles its events up
          THIS tree — through the card's <Link>. Without this, pressing anything in
          the dialog (or its backdrop) would also open the show being copied. */}
      <span className="contents" onClick={(e) => e.stopPropagation()}>
        <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
          <DialogContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                duplicate();
              }}
              className="space-y-4"
            >
              <DialogHeader>
                <DialogTitle>ก๊อปงานนี้เป็นงานใหม่</DialogTitle>
                <DialogDescription>
                  คัดลอกคิว เซ็ตลิสต์ ผังไมค์ และรายชื่อคนมาจาก “{eventName}” เป็นงานใหม่
                  (ฉบับร่าง) — ไม่รวมไฟล์เพลง
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor={`dup-name-${eventId}`}>ชื่องานใหม่</Label>
                  <Input
                    id={`dup-name-${eventId}`}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={`${eventName} (สำเนา)`}
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`dup-date-${eventId}`}>วันที่งาน (เว้นว่างได้)</Label>
                  <Input
                    id={`dup-date-${eventId}`}
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`dup-stage-${eventId}`}>
                    เวลาขึ้นเวที (เว้นว่างได้)
                    {showStartTime && (
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        เดิม {shortClock(showStartTime)}
                      </span>
                    )}
                  </Label>
                  <Input
                    id={`dup-stage-${eventId}`}
                    type="time"
                    value={stageStart}
                    onChange={(e) => setStageStart(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    ใส่แล้วคิวทั้งวัน (ถึงสถานที่ / ห้องแต่งตัว / ถ่ายรูป / STB / บูธ) เลื่อนตามไปเท่ากัน
                    — ส่วนบูธเช็คกับตารางผู้จัดอีกที
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                  disabled={busy}
                >
                  ยกเลิก
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                  ก๊อปงาน
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </span>
    </>
  );
}
