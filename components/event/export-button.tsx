"use client";

import { useState } from "react";
import { toast } from "sonner";
import { FileSpreadsheet } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import type { ExportData } from "@/lib/export-excel";
import type { MicAssignment, ScheduleItem, SetlistItem } from "@/lib/types";

export function ExportButton({ eventId }: { eventId: string }) {
  const [loading, setLoading] = useState(false);

  async function onExport() {
    setLoading(true);
    const supabase = createClient();
    const [evRes, schRes, setRes, micRes] = await Promise.all([
      supabase
        .from("events")
        .select("name, event_date, venue, show_start_time, hard_out_time")
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
    ]);
    setLoading(false);

    if (evRes.error || !evRes.data) {
      toast.error("ดึงข้อมูลไม่สำเร็จ", { description: evRes.error?.message });
      return;
    }
    try {
      const data: ExportData = {
        event: evRes.data as ExportData["event"],
        schedule: (schRes.data ?? []) as ScheduleItem[],
        setlist: (setRes.data ?? []) as SetlistItem[],
        micMap: (micRes.data ?? []) as MicAssignment[],
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
