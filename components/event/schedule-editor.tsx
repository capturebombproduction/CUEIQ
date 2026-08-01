"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { GripVertical, Trash2, Plus, Clock, ChevronUp, ChevronDown } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { newLocalRowId } from "@/lib/mgmt-outbox";
import { OFFLINE_QUEUED_MESSAGE, tryQueueChildList } from "@/lib/mgmt-write";
import { shortClock } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/components/ui/confirm-dialog";
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

// One-click presets for the most common call-time entries (short labels for chips).
const QUICK_KINDS: { kind: ScheduleKind; label: string }[] = [
  { kind: "on_location", label: "ถึงสถานที่" },
  { kind: "dressing_room", label: "ห้องแต่งตัว" },
  { kind: "sound_check", label: "Sound Check" },
  { kind: "stb", label: "STB" },
  { kind: "stage", label: "ขึ้นเวที" },
  { kind: "photo", label: "ถ่ายรูป" },
  { kind: "booth", label: "บูธ/แฟนไซน์" },
];

export function ScheduleEditor({
  eventId,
  tenantId,
  editable,
  initialItems,
  eventName,
}: {
  eventId: string;
  tenantId: string;
  editable: boolean;
  initialItems: ScheduleItem[];
  eventName?: string;
}) {
  const supabase = createClient();
  const confirm = useConfirm();
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

  // ⭐#1 step 5: a write that failed on a DEAD NETWORK queues the whole post-edit
  // list as one offline snapshot and returns true — the caller keeps its
  // optimistic state instead of rolling back. Web (no sink) / real rejections
  // (RLS, 23505) return false and the original error handling runs unchanged.
  // `items` here is this render's list = the pre-edit state (the guard's base).
  async function queueOffline(
    next: ScheduleItem[],
    errorMessage: string | null | undefined
  ): Promise<boolean> {
    const queued = await tryQueueChildList({
      kind: "schedule.upsert",
      eventId,
      tenantId,
      eventName,
      rows: next,
      baseRows: items,
      errorMessage: errorMessage ?? null,
    });
    if (queued) toast.success(OFFLINE_QUEUED_MESSAGE, { id: "mgmt-offline-queued" });
    return queued;
  }

  // One ถ่ายรูป (photo) item per event — enforced by mig 0036's unique index. A
  // unique-violation (23505) means a duplicate photo row; show it in plain Thai.
  const DUP_PHOTO = {
    title: "มีรายการถ่ายรูปอยู่แล้ว",
    description: "ตั้งเวลาถ่ายรูปได้รายการเดียวต่อหนึ่งงาน",
  };

  async function persist(id: string, partial: Partial<ScheduleItem>) {
    const { error } = await supabase
      .from("schedule_items")
      .update(partial)
      .eq("id", id);
    if (error) {
      const next = items.map((it) => (it.id === id ? { ...it, ...partial } : it));
      if (await queueOffline(next, error.message)) return;
      if (error.code === "23505")
        toast.error(DUP_PHOTO.title, { description: DUP_PHOTO.description });
      else toast.error("Save failed", { description: error.message });
    }
  }

  async function addItem(kind: ScheduleKind = "other") {
    // Guard the common case client-side so the band gets a clear message instead
    // of a raw DB error (the index is the race-proof backstop).
    if (kind === "photo" && items.some((i) => i.kind === "photo")) {
      toast.error(DUP_PHOTO.title, { description: DUP_PHOTO.description });
      return;
    }
    setBusy(true);
    const sort = items.length
      ? Math.max(...items.map((i) => i.sort_order)) + 1
      : 1;
    const { data, error } = await supabase
      .from("schedule_items")
      .insert({
        tenant_id: tenantId,
        event_id: eventId,
        kind,
        sort_order: sort,
      })
      .select("*")
      .single();
    setBusy(false);
    if (error || !data) {
      // Offline: mint the row locally (stable client uuid — no remap on sync).
      const local: ScheduleItem = {
        id: newLocalRowId(),
        tenant_id: tenantId,
        event_id: eventId,
        kind,
        label: null,
        location: null,
        start_time: null,
        end_time: null,
        notes: null,
        sort_order: sort,
      };
      if (await queueOffline([...items, local], error?.message)) {
        setItems((prev) => [...prev, local]);
        return;
      }
      if (error?.code === "23505")
        toast.error(DUP_PHOTO.title, { description: DUP_PHOTO.description });
      else toast.error("Failed to add item", { description: error?.message });
      return;
    }
    setItems((prev) => [...prev, data as ScheduleItem]);
  }

  async function removeItem(id: string) {
    const it = items.find((x) => x.id === id);
    const name = it?.label || (it ? SCHEDULE_KIND_LABELS[it.kind] : "");
    const ok = await confirm({
      title: "ลบรายการคิวนี้?",
      description: name ? `“${name}” จะถูกลบออกจากตารางเวลา` : "รายการนี้จะถูกลบออกจากตารางเวลา",
    });
    if (!ok) return;
    const snapshot = items;
    setItems((prev) => prev.filter((it) => it.id !== id));
    const { error } = await supabase
      .from("schedule_items")
      .delete()
      .eq("id", id);
    if (error) {
      if (await queueOffline(snapshot.filter((it) => it.id !== id), error.message)) return;
      toast.error("Delete failed", { description: error.message });
      setItems(snapshot);
    }
  }

  /**
   * Commit `next` as the new order: renumber 1..n and persist only the rows whose
   * OWN sort_order actually changed (comparing by id, not by the item that happened
   * to share an index — otherwise nothing persists). Shared by the desktop drag and
   * the ▲▼ buttons so the two can never drift apart.
   */
  async function applyOrder(next: ScheduleItem[]) {
    const before = items;
    const renumbered = next.map((it, i) => ({ ...it, sort_order: i + 1 }));
    setItems(renumbered);
    const prevById = new Map(before.map((it) => [it.id, it.sort_order]));
    const changed = renumbered.filter((it) => prevById.get(it.id) !== it.sort_order);
    if (changed.length === 0) return;
    // These writes are ABSOLUTE positions, so two of them in flight at once can
    // land out of order and leave two rows sharing a sort_order — which then makes
    // the next ▲ a no-op forever. One at a time; the buttons gate on this.
    setBusy(true);
    try {
      const { error } = await Promise.all(
        changed.map((it) =>
          supabase
            .from("schedule_items")
            .update({ sort_order: it.sort_order })
            .eq("id", it.id)
        )
      ).then((results) => results.find((r) => r.error) ?? { error: null });
      if (error) {
        if (await queueOffline(renumbered, error.message)) return;
        toast.error("Reorder failed", { description: error.message });
        setItems(before);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDrop(targetIndex: number) {
    const from = dragIndex.current;
    dragIndex.current = null;
    setDragOverIndex(null);
    if (from === null || from === targetIndex) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(targetIndex, 0, moved);
    await applyOrder(next);
  }

  /**
   * The touch half of reordering. HTML5 drag never starts from a finger, so on the
   * iPads and iPhones the bands actually use, the grip handle above does nothing —
   * and this list had no other control, which left the call sheet stuck in the
   * order rows happened to be created in (it drives the printed run sheet, ordered
   * by sort_order). Every other ordered list in the app already ships this pair.
   */
  async function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    await applyOrder(next);
  }

  // Day span: earliest start → latest end (end falls back to its start time).
  const starts = items.map((i) => i.start_time).filter(Boolean) as string[];
  const ends = items
    .map((i) => i.end_time || i.start_time)
    .filter(Boolean) as string[];
  const firstStart = starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null;
  const lastEnd = ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : null;

  return (
    <div className="space-y-3">
      {items.length === 0 && (
        <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
          No call time entries yet
        </p>
      )}

      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          <span className="flex items-center gap-1.5 font-medium">
            <Clock className="h-4 w-4 text-muted-foreground" />
            {items.length} รายการ
          </span>
          {firstStart && (
            <span className="tabular-nums text-muted-foreground">
              {shortClock(firstStart)}
              {lastEnd && lastEnd !== firstStart ? `–${shortClock(lastEnd)}` : ""}
            </span>
          )}
        </div>
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs text-muted-foreground">Type</Label>
              <Select
                value={it.kind}
                disabled={!editable}
                onValueChange={(v) => {
                  const next = v as ScheduleKind;
                  if (
                    next === "photo" &&
                    items.some((i) => i.id !== it.id && i.kind === "photo")
                  ) {
                    toast.error(DUP_PHOTO.title, {
                      description: DUP_PHOTO.description,
                    });
                    return;
                  }
                  setLocal(it.id, { kind: next });
                  persist(it.id, { kind: next });
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

            <div className="flex shrink-0 items-end justify-end gap-1 sm:col-span-2">
              {editable && (
                <>
                  {/* Touch can't start an HTML5 drag, so these are the ONLY way to
                      reorder on the iPads the bands work from. Full-size targets,
                      not the 16px icon boxes — a mis-tap here reorders the call
                      sheet the crew reads. Everything here is shrink-0: four
                      controls in a 2/12 cell would otherwise squash to ~22px on an
                      iPad in portrait, which is worse than what this replaced. The
                      grip only appears from lg: up, where there is both room and a
                      mouse to use it with. */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    disabled={idx === 0 || busy}
                    title="เลื่อนขึ้น"
                    aria-label="เลื่อนขึ้น"
                    onClick={() => move(idx, -1)}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    disabled={idx === items.length - 1 || busy}
                    title="เลื่อนลง"
                    aria-label="เลื่อนลง"
                    onClick={() => move(idx, 1)}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                  <button
                    type="button"
                    draggable
                    onDragStart={() => { dragIndex.current = idx; }}
                    onDragEnd={() => { dragIndex.current = null; setDragOverIndex(null); }}
                    className="hidden shrink-0 cursor-grab rounded p-1.5 text-muted-foreground hover:bg-muted active:cursor-grabbing lg:block"
                    title="ลากเพื่อสลับลำดับ (เดสก์ท็อป) — มือถือใช้ปุ่ม ▲▼"
                    aria-label="Drag to reorder"
                  >
                    <GripVertical className="h-4 w-4" />
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-destructive hover:text-destructive"
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
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">เพิ่มด่วน:</p>
          <div className="flex flex-wrap gap-2">
            {QUICK_KINDS.map((q) => (
              <Button
                key={q.kind}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => addItem(q.kind)}
                disabled={busy}
              >
                <Plus className="h-3.5 w-3.5" /> {q.label}
              </Button>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => addItem("other")}
              disabled={busy}
            >
              <Plus className="h-3.5 w-3.5" /> แถวว่าง
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
