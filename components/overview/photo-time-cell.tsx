"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";

/**
 * Inline photo-time editor used on /overview. Lets an approver (label staff) or
 * the band's editor fill the "ถ่ายรูป" call-time for bands that don't run their
 * own photographer (groups.self_photo = false) without opening the full editor.
 * Updates the event's photo schedule_item, or inserts one if none exists yet.
 */
export function PhotoTimeCell({
  eventId,
  tenantId,
  initialItemId,
  initialTime,
  nextSortOrder,
}: {
  eventId: string;
  tenantId: string;
  initialItemId: string | null;
  initialTime: string | null; // "HH:MM" or "HH:MM:SS"
  nextSortOrder: number;
}) {
  const [itemId, setItemId] = useState<string | null>(initialItemId);
  const [value, setValue] = useState(initialTime ? initialTime.slice(0, 5) : "");
  const [committed, setCommitted] = useState(value);
  const [busy, setBusy] = useState(false);

  async function commit() {
    if (value === committed) return;
    const next = value || null;
    setBusy(true);
    const supabase = createClient();
    try {
      if (itemId) {
        const { error } = await supabase
          .from("schedule_items")
          .update({ start_time: next })
          .eq("id", itemId);
        if (error) throw error;
      } else if (next) {
        const { data, error } = await supabase
          .from("schedule_items")
          .insert({
            tenant_id: tenantId,
            event_id: eventId,
            kind: "photo",
            sort_order: nextSortOrder,
            start_time: next,
            label: "ถ่ายรูป",
          })
          .select("id")
          .single();
        if (error) throw error;
        setItemId(data.id as string);
      }
      setCommitted(value);
    } catch (e) {
      toast.error("บันทึกเวลาถ่ายรูปไม่สำเร็จ", {
        description: (e as Error).message,
      });
      setValue(committed); // revert the field to the last saved value
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="time"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        disabled={busy}
        aria-label="เวลาถ่ายรูป"
        className="w-[5.5rem] rounded border bg-background px-1.5 py-0.5 text-sm tabular-nums"
      />
      {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
    </span>
  );
}
