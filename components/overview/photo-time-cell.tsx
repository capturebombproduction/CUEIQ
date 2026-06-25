"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";

/**
 * Inline photo-time editor used on /overview. Lets an approver (label staff) or
 * the band's editor fill the "ถ่ายรูป" call-time window (start–end) for bands that
 * don't run their own photographer (groups.self_photo = false) without opening the
 * full editor. Updates the event's photo schedule_item, or inserts one if none
 * exists yet.
 */
export function PhotoTimeCell({
  eventId,
  tenantId,
  initialItemId,
  initialTime,
  initialEnd,
  nextSortOrder,
  onSaved,
}: {
  eventId: string;
  tenantId: string;
  initialItemId: string | null;
  initialTime: string | null; // start, "HH:MM" or "HH:MM:SS"
  initialEnd: string | null; // end, "HH:MM" or "HH:MM:SS"
  nextSortOrder: number;
  // Bubble a saved value up so the parent's events (and the export image, which
  // reads ev.photo directly — not this editor's state) reflect the edit without a
  // reload. Fires only after the write lands.
  onSaved?: (next: {
    start: string | null;
    end: string | null;
    itemId: string | null;
  }) => void;
}) {
  const [itemId, setItemId] = useState<string | null>(initialItemId);
  const [start, setStart] = useState(initialTime ? initialTime.slice(0, 5) : "");
  const [end, setEnd] = useState(initialEnd ? initialEnd.slice(0, 5) : "");
  const [committedStart, setCommittedStart] = useState(start);
  const [committedEnd, setCommittedEnd] = useState(end);
  const [busy, setBusy] = useState(false);

  async function commit() {
    if (start === committedStart && end === committedEnd) return;
    const nextStart = start || null;
    const nextEnd = end || null;
    setBusy(true);
    const supabase = createClient();
    try {
      let savedItemId = itemId;
      if (itemId) {
        const { error } = await supabase
          .from("schedule_items")
          .update({ start_time: nextStart, end_time: nextEnd })
          .eq("id", itemId);
        if (error) throw error;
      } else if (nextStart || nextEnd) {
        const { data, error } = await supabase
          .from("schedule_items")
          .insert({
            tenant_id: tenantId,
            event_id: eventId,
            kind: "photo",
            sort_order: nextSortOrder,
            start_time: nextStart,
            end_time: nextEnd,
            label: "ถ่ายรูป",
          })
          .select("id")
          .single();
        if (error) throw error;
        savedItemId = data.id as string;
        setItemId(savedItemId);
      }
      setCommittedStart(start);
      setCommittedEnd(end);
      onSaved?.({ start: nextStart, end: nextEnd, itemId: savedItemId });
    } catch (e) {
      toast.error("บันทึกเวลาถ่ายรูปไม่สำเร็จ", {
        description: (e as Error).message,
      });
      setStart(committedStart); // revert the fields to the last saved values
      setEnd(committedEnd);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="time"
        value={start}
        onChange={(e) => setStart(e.target.value)}
        onBlur={commit}
        disabled={busy}
        aria-label="เวลาเริ่มถ่ายรูป"
        className="w-[4.25rem] rounded border bg-background px-1 py-0.5 text-sm tabular-nums"
      />
      <span className="text-muted-foreground">–</span>
      <input
        type="time"
        value={end}
        onChange={(e) => setEnd(e.target.value)}
        onBlur={commit}
        disabled={busy}
        aria-label="เวลาจบถ่ายรูป"
        className="w-[4.25rem] rounded border bg-background px-1 py-0.5 text-sm tabular-nums"
      />
      {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
    </span>
  );
}
