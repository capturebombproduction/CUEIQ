"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { GripVertical, Trash2, Plus } from "lucide-react";
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
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragIndex = useRef<number | null>(null);

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
    if (error) toast.error("Save failed", { description: error.message });
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
      toast.error("Failed to add item", { description: error?.message });
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
      toast.error("Delete failed", { description: error.message });
      setItems(snapshot);
    }
  }

  async function handleDrop(targetIndex: number) {
    const from = dragIndex.current;
    if (from === null || from === targetIndex) {
      dragIndex.current = null;
      setDragOverIndex(null);
      return;
    }
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(targetIndex, 0, moved);
    // renumber sort_order 1..n
    const renumbered = next.map((it, i) => ({ ...it, sort_order: i + 1 }));
    setItems(renumbered);
    dragIndex.current = null;
    setDragOverIndex(null);

    const changed = renumbered.filter(
      (it, i) => it.sort_order !== items[i]?.sort_order
    );
    const { error } = await Promise.all(
      changed.map((it) =>
        supabase
          .from("schedule_items")
          .update({ sort_order: it.sort_order })
          .eq("id", it.id)
      )
    ).then((results) => results.find((r) => r.error) ?? { error: null });
    if (error) {
      toast.error("Reorder failed", { description: error.message });
      setItems(items);
    }
  }

  return (
    <div className="space-y-3">
      {items.length === 0 && (
        <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
          No call time entries yet
        </p>
      )}

      {items.map((it, idx) => (
        <div
          key={it.id}
          className={[
            "rounded-lg border bg-card p-3 shadow-sm transition-shadow sm:p-4",
            dragOverIndex === idx ? "ring-2 ring-primary" : "",
          ].join(" ")}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverIndex(idx);
          }}
          onDrop={(e) => {
            e.preventDefault();
            handleDrop(idx);
          }}
          onDragLeave={() => setDragOverIndex(null)}
        >
          <div className="grid gap-3 sm:grid-cols-12">
            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs text-muted-foreground">Type</Label>
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
              <Label className="text-xs text-muted-foreground">Label</Label>
              <Input
                value={it.label ?? ""}
                disabled={!editable}
                placeholder="e.g. Stage Round 1"
                onChange={(e) => setLocal(it.id, { label: e.target.value })}
                onBlur={(e) =>
                  persist(it.id, { label: e.target.value.trim() || null })
                }
              />
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs text-muted-foreground">Start</Label>
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
              <Label className="text-xs text-muted-foreground">End</Label>
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
                  <button
                    type="button"
                    draggable
                    onDragStart={() => { dragIndex.current = idx; }}
                    onDragEnd={() => { dragIndex.current = null; setDragOverIndex(null); }}
                    className="cursor-grab rounded p-1.5 text-muted-foreground hover:bg-muted active:cursor-grabbing"
                    aria-label="Drag to reorder"
                  >
                    <GripVertical className="h-4 w-4" />
                  </button>
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
              <Label className="text-xs text-muted-foreground">Location</Label>
              <Input
                value={it.location ?? ""}
                disabled={!editable}
                placeholder="e.g. Main Stage"
                onChange={(e) => setLocal(it.id, { location: e.target.value })}
                onBlur={(e) =>
                  persist(it.id, { location: e.target.value.trim() || null })
                }
              />
            </div>
            <div className="space-y-1 sm:col-span-6">
              <Label className="text-xs text-muted-foreground">Notes</Label>
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
          <Plus className="h-4 w-4" /> Add Call Time Entry
        </Button>
      )}
    </div>
  );
}
