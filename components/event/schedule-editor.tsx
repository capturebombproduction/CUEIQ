"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  GripVertical,
  Trash2,
  Plus,
  Clock,
  ChevronUp,
  ChevronDown,
  CalendarClock,
  Camera,
  Flag,
  HandHeart,
  MapPin,
  Mic,
  Radio,
  Shirt,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { newLocalRowId } from "@/lib/mgmt-outbox";
import { OFFLINE_QUEUED_MESSAGE, tryQueueChildList } from "@/lib/mgmt-write";
import { noRowsMessage, wroteNothing } from "@/lib/write-guard";
import { shortClock } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { SaveStatus, useSaveSignal } from "@/components/event/save-status";
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

// The read-only call sheet (spec §G.3): one icon per kind, and the short name a
// row goes by when it has no label of its own.
const SCHED_ICON: Partial<Record<ScheduleKind, LucideIcon>> = {
  on_location: MapPin,
  dressing_room: Shirt,
  sound_check: Mic,
  costume: Sparkles,
  stb: Flag,
  stage: Radio,
  booth: HandHeart,
  photo: Camera,
};
const KIND_SHORT: Partial<Record<ScheduleKind, string>> = {
  ...Object.fromEntries(QUICK_KINDS.map((q) => [q.kind, q.label])),
  costume: "เปลี่ยนชุด",
};

/** Members read the day; they do not edit it. A vertical timeline down the clock
 *  — start time, a dot on a rail, what happens and where — with the stage row
 *  carrying the band's rail. Rows without a time keep their place at the end. */
function ScheduleTimeline({ items }: { items: ScheduleItem[] }) {
  const ordered = [...items].sort(
    (a, b) =>
      (a.start_time ?? "￿").localeCompare(b.start_time ?? "￿") ||
      (a.sort_order ?? 0) - (b.sort_order ?? 0)
  );
  return (
    <ol className="relative space-y-[2px] before:absolute before:bottom-3 before:left-[80px] before:top-3 before:w-[2px] before:bg-foreground/15">
      {ordered.map((it) => {
        const Icon = SCHED_ICON[it.kind] ?? CalendarClock;
        const stage = it.kind === "stage";
        const title = it.label?.trim() || KIND_SHORT[it.kind] || SCHEDULE_KIND_LABELS[it.kind] || it.kind || "—";
        return (
          <li
            key={it.id}
            className={cn(
              "relative flex gap-3 px-2 py-2.5",
              stage && "slab shadow-[inset_3px_0_0_hsl(var(--primary)),inset_0_0_0_1px_hsl(var(--border))]"
            )}
          >
            <div className="w-14 flex-none text-right leading-tight">
              <div className="num text-[17px]">{shortClock(it.start_time) || "—"}</div>
              {it.end_time && <div className="num text-[12px] text-faint">{shortClock(it.end_time)}</div>}
            </div>
            <span
              aria-hidden
              className={cn(
                "relative z-[1] mt-1.5 h-2.5 w-2.5 flex-none",
                stage ? "bg-primary shadow-[0_0_0_4px_hsl(var(--primary)/.2)]" : "bg-foreground/40"
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[15px] font-medium leading-snug">
                <Icon aria-hidden className="h-4 w-4 flex-none text-muted-foreground" />
                <span className="min-w-0">{title}</span>
              </div>
              {it.location && <div className="text-[12.5px] text-muted-foreground">{it.location}</div>}
              {it.notes && <div className="text-[12.5px] text-muted-foreground">{it.notes}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

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
  // Rows whose folded location / notes the user opened on a phone. A row that
  // already HAS either is always shown open — nothing typed ever hides.
  const [extraOpen, setExtraOpen] = useState<Set<string>>(new Set());
  const hasExtra = (it: ScheduleItem) => !!it.location?.trim() || !!it.notes?.trim();
  const showExtra = (it: ScheduleItem) => hasExtra(it) || extraOpen.has(it.id);
  // …and once a row has been shown open, it STAYS open. Otherwise clearing a
  // location to retype it (the usual fix on a copied show) emptied the field,
  // folded it away under the thumb, and the rest of the typing went nowhere.
  useEffect(() => {
    const opened = items.filter(hasExtra).map((i) => i.id);
    if (opened.some((id) => !extraOpen.has(id))) {
      setExtraOpen((prev) => new Set([...prev, ...opened]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  const dragIndex = useRef<number | null>(null);
  // Every field here autosaves on blur and always has; what was missing is any
  // sign of it. See components/event/save-status.tsx.
  const save = useSaveSignal();

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

  // Several ถ่ายรูป rounds per event are allowed — each one needs its own NAME
  // (mig 0042; 0036 used to cap it at one, which stopped a band with two costumes
  // entering the second photo call). The unique key is the trimmed label, with an
  // unnamed row treated as "ถ่ายรูป", so two devices filling the same round still
  // collide exactly as before. A 23505 now means the NAME is taken.
  const DUP_PHOTO = {
    title: "ชื่อรอบถ่ายรูปซ้ำ",
    description: "มีรอบถ่ายรูปชื่อนี้อยู่แล้ว — ตั้งชื่อให้ต่างกัน เช่น “ชุด 1” / “ชุด 2”",
  };

  async function persist(id: string, partial: Partial<ScheduleItem>) {
    save.begin();
    try {
      await persistInner(id, partial);
    } catch (e) {
      // A fetch that THROWS (offline mid-flight, aborted) never reached the code
      // below, so the badge stayed on กำลังบันทึก… forever with no toast — and the
      // leave-the-page warning would count it as in flight for the rest of the
      // session.
      save.end(false);
      toast.error("Save failed", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }

  async function persistInner(id: string, partial: Partial<ScheduleItem>) {
    const { data, error } = await supabase
      .from("schedule_items")
      .update(partial)
      .eq("id", id)
      .select("id");
    if (error) {
      // An offline queue is a SAVE, not a failure — the row is on disk and will
      // flush. Reported as such below, once queueOffline has had its say.
      const next = items.map((it) => (it.id === id ? { ...it, ...partial } : it));
      if (await queueOffline(next, error.message)) {
        save.end(true);
        return;
      }
      save.end(false);
      if (error.code === "23505")
        toast.error(DUP_PHOTO.title, { description: DUP_PHOTO.description });
      else toast.error("Save failed", { description: error.message });
      return;
    }
    // No error and no row = the write reached the server and changed nothing (sent
    // anon after a failed token refresh, or the row is gone). Every field here
    // autosaves on blur, so staying silent means the call sheet sits on screen
    // looking saved and is simply not there. See lib/write-guard.ts.
    if (wroteNothing(data)) {
      save.end(false);
      toast.error("ยังไม่ได้บันทึก", { description: await noRowsMessage() });
      return;
    }
    save.end(true);
  }

  async function addItem(kind: ScheduleKind = "other") {
    setBusy(true);
    const sort = items.length
      ? Math.max(...items.map((i) => i.sort_order)) + 1
      : 1;
    // A SECOND photo round arrives already named, because the rule that lets it
    // exist is that it has one (mig 0042) — inserting another blank row would just
    // collide with the first and hand the band a duplicate-name error for a button
    // press they had no way to get right. "รอบ 2" is a starting point they can
    // rename to whatever the day actually is ("ชุด 2", "ก่อนขึ้นเวที").
    const photoRounds = items.filter((i) => i.kind === "photo").length;
    const label = kind === "photo" && photoRounds > 0 ? `รอบ ${photoRounds + 1}` : null;
    const { data, error } = await supabase
      .from("schedule_items")
      .insert({
        tenant_id: tenantId,
        event_id: eventId,
        kind,
        sort_order: sort,
        ...(label ? { label } : {}),
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
        label,
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
    const { data, error } = await supabase
      .from("schedule_items")
      .delete()
      .eq("id", id)
      .select("id");
    if (error) {
      if (await queueOffline(snapshot.filter((it) => it.id !== id), error.message)) return;
      toast.error("Delete failed", { description: error.message });
      setItems(snapshot);
      return;
    }
    // No error and no row = nothing was actually deleted (anon write) — the row
    // still exists server-side even though it just vanished from this screen.
    if (wroteNothing(data)) {
      toast.error("ยังไม่ได้บันทึก", { description: await noRowsMessage() });
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
      const results = await Promise.all(
        changed.map((it) =>
          supabase
            .from("schedule_items")
            .update({ sort_order: it.sort_order })
            .eq("id", it.id)
            .select("id")
        )
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) {
        if (await queueOffline(renumbered, failed.error.message)) return;
        toast.error("Reorder failed", { description: failed.error.message });
        setItems(before);
        return;
      }
      // No error but zero rows on any of these writes = the batch was sent anon
      // after a failed token refresh — the new order never reached the DB.
      if (results.some((r) => wroteNothing(r.data))) {
        toast.error("ยังไม่ได้บันทึก", { description: await noRowsMessage() });
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

  const summaryStrip = items.length > 0 && (
    <div className="well flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[2px] px-3 py-2 text-sm shadow-edge">
      <span className="flex items-center gap-1.5 font-medium">
        <Clock aria-hidden className="h-4 w-4 text-muted-foreground" />
        <span className="num text-[15px]">{items.length}</span> รายการ
      </span>
      {firstStart && (
        <span className="num text-[15px] text-muted-foreground">
          {shortClock(firstStart)}
          {lastEnd && lastEnd !== firstStart ? `–${shortClock(lastEnd)}` : ""}
        </span>
      )}
      {/* The receipt, at the end of the row the operator is already reading. */}
      <SaveStatus state={save.state} className="ml-auto" />
    </div>
  );

  // Members (and label staff) read the day: the call sheet as a timeline, not a
  // grid of disabled fields. (All hooks are above this line.)
  if (!editable) {
    return (
      <div className="space-y-3">
        {items.length === 0 ? (
          <p className="rounded-[2px] border border-dashed py-8 text-center text-sm text-muted-foreground">
            No call time entries yet
          </p>
        ) : (
          <>
            {summaryStrip}
            <ScheduleTimeline items={items} />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.length === 0 && (
        <p className="rounded-[2px] border border-dashed py-8 text-center text-sm text-muted-foreground">
          No call time entries yet
        </p>
      )}

      {summaryStrip}

      {items.map((it, idx) => (
        <div
          key={it.id}
          className={cn(
            "slab p-3 sm:p-4",
            dragOverIndex === idx && "shadow-[inset_0_0_0_2px_hsl(var(--primary))]"
          )}
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
          {/* On a phone the row used to stack all six fields one per line — ~480px a
              row, ~3,000px to retime a six-row day. Measured 2026-09-28 over 198 real
              rows: start 99% filled, end 45%, label 41%, location 10%, notes 6%. So
              below sm the two times share a line right under the type, and location
              / notes fold behind one small button until a row actually uses them.
              From sm up the order and layout are exactly what they were. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-12">
            <div className="order-1 col-span-2 space-y-1 sm:order-none sm:col-span-3">
              <Label htmlFor={`sc-${it.id}-kind`} className="text-[13px] font-medium text-muted-foreground">Type</Label>
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
                <SelectTrigger id={`sc-${it.id}-kind`}>
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

            <div className="order-4 col-span-2 space-y-1 sm:order-none sm:col-span-2 lg:col-span-3">
              <Label htmlFor={`sc-${it.id}-label`} className="text-[13px] font-medium text-muted-foreground">Label</Label>
              <Input
                id={`sc-${it.id}-label`}
                value={it.label ?? ""}
                disabled={!editable}
                placeholder="e.g. Stage Round 1"
                onChange={(e) => setLocal(it.id, { label: e.target.value })}
                onBlur={(e) =>
                  persist(it.id, { label: e.target.value.trim() || null })
                }
              />
            </div>

            <div className="order-2 min-w-0 space-y-1 sm:order-none sm:col-span-2">
              <Label htmlFor={`sc-${it.id}-start`} className="text-[13px] font-medium text-muted-foreground">Start</Label>
              <Input
                id={`sc-${it.id}-start`}
                type="time"
                className="num"
                value={it.start_time?.slice(0, 5) ?? ""}
                disabled={!editable}
                onChange={(e) => setLocal(it.id, { start_time: e.target.value })}
                onBlur={(e) =>
                  persist(it.id, { start_time: e.target.value || null })
                }
              />
            </div>

            <div className="order-3 min-w-0 space-y-1 sm:order-none sm:col-span-2">
              <Label htmlFor={`sc-${it.id}-end`} className="text-[13px] font-medium text-muted-foreground">End</Label>
              <Input
                id={`sc-${it.id}-end`}
                type="time"
                className="num"
                value={it.end_time?.slice(0, 5) ?? ""}
                disabled={!editable}
                onChange={(e) => setLocal(it.id, { end_time: e.target.value })}
                onBlur={(e) =>
                  persist(it.id, { end_time: e.target.value || null })
                }
              />
            </div>

            <div className={`order-6 flex shrink-0 items-end justify-end [justify-content:safe_flex-end] gap-1 sm:order-none sm:col-span-3 lg:col-span-2 ${showExtra(it) ? "col-span-2" : "col-span-1"}`}>
              {editable && (
                <>
                  {/* Touch can't start an HTML5 drag, so these are the ONLY way to
                      reorder on the iPads the bands work from. Full-size targets,
                      not the 16px icon boxes — a mis-tap here reorders the call
                      sheet the crew reads. Everything here is shrink-0: four
                      controls in a 2/12 cell would otherwise squash to ~22px on an
                      iPad in portrait, which is worse than what this replaced. The
                      grip only appears where there is a mouse to use it with
                      ((hover: hover) — was lg:, which still drew it, dead, on an
                      iPad in landscape).
                      Width: three of these are 140px. At 2/12 the cell is 86-128px
                      from 640 to 892px, and justify-end spilled the rest LEFT over
                      the End field — a tap on its clock icon hit ▲ and reordered the
                      call sheet. So the cell is 3/12 until lg (Label gives the
                      column up; lg+ is unchanged), and `safe` sends any overflow
                      right, never over a field. justify-end stays as the fallback
                      for an engine that drops the `safe` keyword. */}
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
                    className="hidden h-11 shrink-0 cursor-grab place-items-center rounded-[2px] px-1.5 text-muted-foreground hover:bg-muted active:cursor-grabbing lg:[@media(hover:hover)]:grid"
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
                    aria-label="ลบรายการนี้"
                    onClick={() => removeItem(it.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>

            {!showExtra(it) && (
              <button
                type="button"
                onClick={() => setExtraOpen((prev) => new Set(prev).add(it.id))}
                className="order-5 col-span-1 self-center justify-self-start min-h-11 rounded-[2px] px-2 text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline sm:hidden"
              >
                + สถานที่ / โน้ต
              </button>
            )}
            <div className={`order-7 col-span-2 space-y-1 sm:order-none sm:col-span-6 ${showExtra(it) ? "" : "hidden sm:block"}`}>
              <Label htmlFor={`sc-${it.id}-location`} className="text-[13px] font-medium text-muted-foreground">Location</Label>
              <Input
                id={`sc-${it.id}-location`}
                value={it.location ?? ""}
                disabled={!editable}
                placeholder="e.g. Main Stage"
                onChange={(e) => setLocal(it.id, { location: e.target.value })}
                onBlur={(e) =>
                  persist(it.id, { location: e.target.value.trim() || null })
                }
              />
            </div>
            <div className={`order-8 col-span-2 space-y-1 sm:order-none sm:col-span-6 ${showExtra(it) ? "" : "hidden sm:block"}`}>
              <Label htmlFor={`sc-${it.id}-notes`} className="text-[13px] font-medium text-muted-foreground">Notes</Label>
              <Input
                id={`sc-${it.id}-notes`}
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
          <p className="text-[13px] font-medium text-muted-foreground">เพิ่มด่วน:</p>
          <div className="flex flex-wrap gap-2">
            {QUICK_KINDS.map((q) => (
              <Button
                key={q.kind}
                type="button"
                variant="secondary"
                onClick={() => addItem(q.kind)}
                disabled={busy}
              >
                <Plus aria-hidden className="h-4 w-4" /> {q.label}
              </Button>
            ))}
            <Button
              type="button"
              variant="secondary"
              onClick={() => addItem("other")}
              disabled={busy}
            >
              <Plus aria-hidden className="h-4 w-4" /> แถวว่าง
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
