"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ChevronUp, ChevronDown, Trash2, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SCHEDULE_KIND_LABELS,
  type ScheduleItem,
  type ScheduleKind,
} from "@/lib/types";

const KIND_KEYS = Object.keys(SCHEDULE_KIND_LABELS) as ScheduleKind[];

export function ScheduleEditor({
  eventId,
  tenantId,
  editable,
  initialItems,
}: {
  eventId: string;
  tenantId: string;
  editable: boolean;
  initialItems: ScheduleItem[];
}) {
  const supabase = createClient();
  const [items, setItems] = useState<ScheduleItem[]>(
    [...initialItems].sort((a, b) => a.sort_order - b.sort_order)
  );
  const [busy, setBusy] = useState(false);

  function setLocal(id: string, partial: Partial<ScheduleItem>) {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, ...partial } : it))
    );
  }

  async function persist(id: string, partial: Partial<ScheduleItem>) {
    const { error } = await supabase
      .from("schedule_items")
      .update(partial)
      .eq("id", id);
    if (error) toast.error("บันทึกไม่สำเร็จ", { description: error.message });
  }

  async function addItem() {
    setBusy(true);
    const sort = items.length
      ? Math.max(...items.map((i) => i.sort_order)) + 1
      : 1;
    const { data, error } = await supabase
      .from("schedule_items")
      .insert({
        tenant_id: tenantId,
        event_id: eventId,
        kind: "other",
        sort_order: sort,
      })
      .select("*")
      .single();
    setBusy(false);
    if (error || !data) {
      toast.error("เพิ่มรายการไม่สำเร็จ", { description: error?.message });
      return;
    }
    setItems((prev) => [...prev, data as ScheduleItem]);
  }

  async function removeItem(id: string) {
    const snapshot = items;
    setItems((prev) => prev.filter((it) => it.id !== id));
    const { error } = await supabase
      .from("schedule_items")
      .delete()
      .eq("id", id);
    if (error) {
      toast.error("ลบไม่สำเร็จ", { description: error.message });
      setItems(snapshot);
    }
  }

  async function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= items.length) return;
    const a = items[index];
    const b = items[target];
    const next = [...items];
    next[index] = { ...b, sort_order: a.sort_order };
    next[target] = { ...a, sort_order: b.sort_order };
    next.sort((x, y) => x.sort_order - y.sort_order);
    setItems(next);
    await Promise.all([
      supabase
        .from("schedule_items")
        .update({ sort_order: b.sort_order })
        .eq("id", a.id),
      supabase
        .from("schedule_items")
        .update({ sort_order: a.sort_order })
        .eq("id", b.id),
    ]);
  }

  return (
    <div className="space-y-3">
      {items.length === 0 && (
        <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
          ยังไม่มีรายการนัดหมาย
        </p>
      )}

      {items.map((it, idx) => (
        <div
          key={it.id}
          className="rounded-lg border bg-card p-3 shadow-sm sm:p-4"
        >
          <div className="grid gap-3 sm:grid-cols-12">
            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs text-muted-foreground">ประเภท</Label>
              <Select
                value={it.kind}
                disabled={!editable}
                onValueChange={(v) => {
                  setLocal(it.id, { kind: v as ScheduleKind });
                  persist(it.id, { kind: v as ScheduleKind });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KIND_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {SCHEDULE_KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs text-muted-foreground">หัวข้อ</Label>
              <Input
                value={it.label ?? ""}
                disabled={!editable}
                placeholder="เช่น Stage Round 1"
                onChange={(e) => setLocal(it.id, { label: e.target.value })}
                onBlur={(e) =>
                  persist(it.id, { label: e.target.value.trim() || null })
                }
              />
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs text-muted-foreground">เริ่ม</Label>
              <Input
                type="time"
                value={it.start_time?.slice(0, 5) ?? ""}
                disabled={!editable}
                onChange={(e) => setLocal(it.id, { start_time: e.target.value })}
                onBlur={(e) =>
                  persist(it.id, { start_time: e.target.value || null })
                }
              />
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs text-muted-foreground">จบ</Label>
              <Input
                type="time"
                value={it.end_time?.slice(0, 5) ?? ""}
                disabled={!editable}
                onChange={(e) => setLocal(it.id, { end_time: e.target.value })}
                onBlur={(e) =>
                  persist(it.id, { end_time: e.target.value || null })
                }
              />
            </div>

            <div className="flex items-end justify-end gap-1 sm:col-span-2">
              {editable && (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => move(idx, -1)}
                    disabled={idx === 0}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => move(idx, 1)}
                    disabled={idx === items.length - 1}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => removeItem(it.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>

            <div className="space-y-1 sm:col-span-6">
              <Label className="text-xs text-muted-foreground">สถานที่</Label>
              <Input
                value={it.location ?? ""}
                disabled={!editable}
                placeholder="เช่น Main Stage"
                onChange={(e) => setLocal(it.id, { location: e.target.value })}
                onBlur={(e) =>
                  persist(it.id, { location: e.target.value.trim() || null })
                }
              />
            </div>
            <div className="space-y-1 sm:col-span-6">
              <Label className="text-xs text-muted-foreground">โน้ต</Label>
              <Input
                value={it.notes ?? ""}
                disabled={!editable}
                onChange={(e) => setLocal(it.id, { notes: e.target.value })}
                onBlur={(e) =>
                  persist(it.id, { notes: e.target.value.trim() || null })
                }
              />
            </div>
          </div>
        </div>
      ))}

      {editable && (
        <Button
          type="button"
          variant="outline"
          onClick={addItem}
          disabled={busy}
          className="w-full"
        >
          <Plus className="h-4 w-4" /> เพิ่มรายการนัดหมาย
        </Button>
      )}
    </div>
  );
}
