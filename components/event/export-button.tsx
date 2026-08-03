"use client";

import { useState } from "react";
import { toast } from "sonner";
import { FileSpreadsheet } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import type { ExportData } from "@/lib/export-excel";
import type { Member, MicAssignment, ScheduleItem, SetlistItem } from "@/lib/types";

export function ExportButton({
  eventId,
  groupId,
}: {
  eventId: string;
  /** The event's band — `members` is group-scoped, not event-scoped. */
  groupId: string;
}) {
  const [loading, setLoading] = useState(false);

  async function onExport() {
    setLoading(true);
    const supabase = createClient();
    const [evRes, schRes, setRes, micRes, memRes, lineRes] = await Promise.all([
      supabase
        .from("events")
        .select(
          "name, event_date, venue, show_start_time, hard_out_time, notes, costume_theme"
        )
        .eq("id", eventId)
        .single(),
      supabase
        .from("schedule_items")
        .select("*")
        .eq("event_id", eventId)
        .order("sort_order", { ascending: true }),
      supabase
        .from("setlist_items")
        .select("*")
        .eq("event_id", eventId)
        .order("sort_order", { ascending: true }),
      supabase
        .from("mic_assignments")
        .select("*")
        .eq("event_id", eventId)
        .order("mic_number", { ascending: true })
        .order("order_index", { ascending: true }),
      supabase
        .from("members")
        .select("*")
        .eq("group_id", groupId)
        .order("sort_order", { ascending: true }),
      supabase
        .from("event_members")
        .select("member_id")
        .eq("event_id", eventId),
    ]);
    setLoading(false);

    if (evRes.error || !evRes.data) {
      toast.error("ดึงข้อมูลไม่สำเร็จ", { description: evRes.error?.message });
      return;
    }
    // This workbook gets printed and handed to venue staff, so a list read that
    // failed (flaky venue data) must NOT fall back to [] — that would ship a Run
    // Sheet with headers and zero rows while we toast success. Fail the whole
    // export instead. An empty-but-successful read (or rows hidden by RLS) still
    // exports as before.
    const readErr =
      schRes.error ?? setRes.error ?? micRes.error ?? memRes.error ?? lineRes.error;
    if (
      readErr ||
      !schRes.data ||
      !setRes.data ||
      !micRes.data ||
      !memRes.data ||
      !lineRes.data
    ) {
      toast.error("ดึงข้อมูลไม่ครบ — ไม่ได้สร้างไฟล์", {
        description: readErr?.message ?? "เน็ตอาจไม่เสถียร ลองใหม่อีกครั้ง",
      });
      return;
    }
    try {
      const data: ExportData = {
        event: evRes.data as ExportData["event"],
        schedule: schRes.data as ScheduleItem[],
        setlist: setRes.data as SetlistItem[],
        micMap: micRes.data as MicAssignment[],
        members: memRes.data as Member[],
        lineup: (lineRes.data as { member_id: string }[]).map((r) => r.member_id),
      };
      // Lazy-load SheetJS only when the user actually exports.
      const { downloadRunSheet } = await import("@/lib/export-excel");
      downloadRunSheet(data);
      toast.success("ดาวน์โหลด Excel แล้ว 📄");
    } catch (e) {
      toast.error("Export ไม่สำเร็จ", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <Button variant="outline" onClick={onExport} disabled={loading}>
      <FileSpreadsheet className="h-4 w-4" />
      {loading ? "กำลังสร้าง…" : "Export Excel"}
    </Button>
  );
}
