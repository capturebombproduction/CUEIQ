"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";

// Idol groups run the same show repeatedly, so let an editor clone an event with
// its schedule + setlist + mic map in one click. Audio files are NOT copied: a
// setlist item's audio lives at an event-scoped Storage path, and sharing the path
// across two events would mean deleting one show's file breaks the other.

type Row = Record<string, unknown>;

function childRows(rows: Row[] | null, drop: string[], eventId: string): Row[] {
  return (rows ?? []).map((row) => {
    const o: Row = { ...row };
    for (const k of drop) delete o[k];
    o.event_id = eventId;
    return o;
  });
}

export function DuplicateEventButton({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function duplicate(e: React.MouseEvent) {
    e.preventDefault(); // the card is a <Link> — don't navigate
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    const supabase = createClient();
    try {
      const { data: src, error: srcErr } = await supabase
        .from("events")
        .select("*")
        .eq("id", eventId)
        .single();
      if (srcErr || !src) throw srcErr ?? new Error("ไม่พบงานต้นฉบับ");
      const ev = src as Row;

      const [sched, setl, mic] = await Promise.all([
        supabase.from("schedule_items").select("*").eq("event_id", eventId),
        supabase.from("setlist_items").select("*").eq("event_id", eventId),
        supabase.from("mic_assignments").select("*").eq("event_id", eventId),
      ]);

      const { data: created, error: insErr } = await supabase
        .from("events")
        .insert({
          tenant_id: ev.tenant_id,
          group_id: ev.group_id,
          name: `${ev.name ?? "งาน"} (สำเนา)`,
          event_type: ev.event_type,
          venue: ev.venue,
          show_start_time: ev.show_start_time,
          hard_out_time: ev.hard_out_time,
          notes: ev.notes,
          map_url: ev.map_url,
          costume_theme: ev.costume_theme,
          status: "draft",
          event_date: null, // a new show sets its own date
        })
        .select("id")
        .single();
      if (insErr || !created) throw insErr ?? new Error("สร้างงานใหม่ไม่สำเร็จ");
      const newId = created.id as string;

      const children: [string, Row[]][] = [
        ["schedule_items", childRows(sched.data as Row[] | null, ["id", "event_id"], newId)],
        [
          "setlist_items",
          childRows(
            setl.data as Row[] | null,
            ["id", "event_id", "audio_path", "audio_name"],
            newId
          ),
        ],
        ["mic_assignments", childRows(mic.data as Row[] | null, ["id", "event_id", "created_at"], newId)],
      ];
      for (const [table, rows] of children) {
        if (!rows.length) continue;
        const { error } = await supabase.from(table).insert(rows);
        if (error) throw error;
      }

      toast.success("ก๊อปงานเรียบร้อย — เปิดงานใหม่ให้แล้ว");
      router.push(`/events/${newId}`);
    } catch (err) {
      toast.error("ก๊อปงานไม่สำเร็จ", {
        description: err instanceof Error ? err.message : undefined,
      });
      setBusy(false);
    }
  }

  return (
    <button
      onClick={duplicate}
      disabled={busy}
      title="ก๊อปงานนี้เป็นงานใหม่ (รวมคิว / เซ็ตลิสต์ / ไมค์ — ไม่รวมไฟล์เพลง)"
      className="absolute bottom-2 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-md border bg-background/80 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition hover:text-primary focus:opacity-100 group-hover:opacity-100 disabled:opacity-100"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}
