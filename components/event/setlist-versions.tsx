"use client";

import { useState } from "react";
import { toast } from "sonner";
import { History, Save, RotateCcw, Loader2, Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { SetlistItem } from "@/lib/types";

// Snapshot of one setlist row (no id/audio — restore re-creates fresh rows).
export type SnapshotItem = Pick<
  SetlistItem,
  | "kind"
  | "title"
  | "duration_seconds"
  | "buffer_before_seconds"
  | "buffer_after_seconds"
  | "mic_slots"
  | "notes"
  | "sort_order"
>;

interface Version {
  id: string;
  label: string | null;
  snapshot: SnapshotItem[];
  created_at: string;
}

function toSnapshot(items: SetlistItem[]): SnapshotItem[] {
  return items.map((it) => ({
    kind: it.kind,
    title: it.title,
    duration_seconds: it.duration_seconds,
    buffer_before_seconds: it.buffer_before_seconds,
    buffer_after_seconds: it.buffer_after_seconds,
    mic_slots: it.mic_slots,
    notes: it.notes,
    sort_order: it.sort_order,
  }));
}

function fmt(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString("th-TH", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SetlistVersions({
  eventId,
  tenantId,
  items,
  onRestore,
}: {
  eventId: string;
  tenantId: string;
  items: SetlistItem[];
  onRestore: (snapshot: SnapshotItem[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const supabase = createClient();

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("setlist_versions")
      .select("id, label, snapshot, created_at")
      .eq("event_id", eventId)
      .order("created_at", { ascending: false });
    setVersions((data ?? []) as Version[]);
    setLoading(false);
  }

  async function save() {
    setBusy(true);
    const { error } = await supabase.from("setlist_versions").insert({
      tenant_id: tenantId,
      event_id: eventId,
      label: label.trim() || `บันทึกเมื่อ ${fmt(new Date().toISOString())}`,
      snapshot: toSnapshot(items),
    });
    setBusy(false);
    if (error) {
      toast.error("บันทึกเวอร์ชันไม่สำเร็จ", { description: error.message });
      return;
    }
    setLabel("");
    toast.success("บันทึกเวอร์ชันแล้ว");
    load();
  }

  async function restore(v: Version) {
    if (
      !window.confirm(
        `กู้คืนเวอร์ชันนี้? เซ็ตลิสต์ปัจจุบันจะถูกแทนที่ด้วย ${v.snapshot.length} รายการ`
      )
    )
      return;
    setBusy(true);
    try {
      await onRestore(v.snapshot);
      toast.success("กู้คืนเซ็ตลิสต์แล้ว");
      setOpen(false);
    } catch (e) {
      toast.error("กู้คืนไม่สำเร็จ", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) load();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <History className="h-4 w-4" /> ประวัติ/เวอร์ชัน
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>ประวัติเซ็ตลิสต์</DialogTitle>
          <DialogDescription>
            บันทึกสแน็ปช็อตของเซ็ตลิสต์ตอนนี้ไว้ แล้วกู้คืนได้ถ้าแก้ผิด
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="ชื่อเวอร์ชัน (เช่น ก่อนซ้อม)"
            className="h-9"
          />
          <Button type="button" onClick={save} disabled={busy} className="shrink-0">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            บันทึกตอนนี้
          </Button>
        </div>

        <div className="space-y-2">
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">กำลังโหลด…</p>
          ) : versions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              ยังไม่มีเวอร์ชันที่บันทึกไว้
            </p>
          ) : (
            versions.map((v) => (
              <div
                key={v.id}
                className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {v.label || "ไม่มีชื่อ"}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" /> {fmt(v.created_at)} ·{" "}
                    {v.snapshot.length} รายการ
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => restore(v)}
                  disabled={busy}
                  className="shrink-0"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> กู้คืน
                </Button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
