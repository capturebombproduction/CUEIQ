"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { toast } from "sonner";
import {
  ChevronUp,
  ChevronDown,
  Trash2,
  Copy,
  Plus,
  Mic,
  AlarmClock,
  CheckCircle2,
  ListMusic,
  GripVertical,
  Radio,
  RotateCcw,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { deleteAudio } from "@/lib/audio-store";
import { removeEventAudio } from "@/lib/audio-remote";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  SETLIST_KIND_LABELS,
  SETLIST_KIND_SHORT,
  type Member,
  type MicSlot,
  type SetlistItem,
  type SetlistKind,
  type Song,
} from "@/lib/types";
import {
  computeSetlistTimes,
  formatDuration,
  parseClockToSeconds,
  parseDurationToSeconds,
  formatClockOfDay,
} from "@/lib/time";

const KIND_KEYS = Object.keys(SETLIST_KIND_LABELS) as SetlistKind[];

// ---- m:ss duration field with its own text buffer --------------------------
function DurationField({
  seconds,
  disabled,
  onCommit,
}: {
  seconds: number;
  disabled?: boolean;
  onCommit: (s: number) => void;
}) {
  const [text, setText] = useState(formatDuration(seconds));
  useEffect(() => {
    setText(formatDuration(seconds));
  }, [seconds]);
  return (
    <Input
      value={text}
      disabled={disabled}
      inputMode="numeric"
      placeholder="m:ss"
      className="tabular-nums"
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      onBlur={() => {
        const s = parseDurationToSeconds(text);
        if (s == null) {
          setText(formatDuration(seconds));
          toast.error("รูปแบบเวลาไม่ถูกต้อง", { description: "ใช้รูปแบบ m:ss เช่น 3:45" });
        } else {
          onCommit(s);
        }
      }}
    />
  );
}

// ---- per-item mic slot editor (dialog) -------------------------------------
function MicSlotsDialog({
  item,
  members,
  disabled,
  onSave,
}: {
  item: SetlistItem;
  members: Member[];
  disabled?: boolean;
  onSave: (slots: MicSlot[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState<MicSlot[]>(item.mic_slots ?? []);

  useEffect(() => {
    if (open) setSlots(item.mic_slots ?? []);
  }, [open, item.mic_slots]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-start">
          <Mic className="h-4 w-4" />
          ไมค์ {item.mic_slots?.length ? `(${item.mic_slots.length})` : ""}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ไมค์ + สมาชิก — {item.title || "รายการ"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          {slots.length === 0 && (
            <p className="py-2 text-center text-sm text-muted-foreground">
              ยังไม่มีไมค์
            </p>
          )}
          {slots.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                className="w-20"
                placeholder="ไมค์"
                value={s.mic}
                disabled={disabled}
                onChange={(e) =>
                  setSlots((prev) =>
                    prev.map((x, j) =>
                      j === i ? { ...x, mic: e.target.value } : x
                    )
                  )
                }
              />
              <Input
                className="flex-1"
                placeholder="สมาชิก"
                value={s.member}
                disabled={disabled}
                onChange={(e) =>
                  setSlots((prev) =>
                    prev.map((x, j) =>
                      j === i ? { ...x, member: e.target.value } : x
                    )
                  )
                }
              />
              {!disabled && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-destructive"
                  onClick={() =>
                    setSlots((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>

        {!disabled && (
          <div className="space-y-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSlots((prev) => [...prev, { mic: "", member: "" }])}
            >
              <Plus className="h-4 w-4" /> เพิ่มไมค์
            </Button>
            {members.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                <span className="self-center text-xs text-muted-foreground">
                  เพิ่มเร็ว:
                </span>
                {members.map((m) => {
                  const label = m.nickname || m.name;
                  // already on this item — don't let the SAME PERSON be added twice.
                  // (Mic numbers CAN repeat on purpose — mics get shared/passed around
                  // when there are guests and mics run out.)
                  const added = slots.some(
                    (s) =>
                      s.member.trim().toLowerCase() === label.trim().toLowerCase()
                  );
                  return (
                    <Button
                      key={m.id}
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={added}
                      title={added ? "เพิ่มแล้ว" : undefined}
                      className="h-7 disabled:opacity-40"
                      onClick={() =>
                        setSlots((prev) => [
                          ...prev,
                          {
                            mic: m.mic_number != null ? String(m.mic_number) : "",
                            member: label,
                          },
                        ])
                      }
                    >
                      {m.mic_number != null ? `${m.mic_number} ` : ""}
                      {label}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              ปิด
            </Button>
          </DialogClose>
          {!disabled && (
            <Button
              type="button"
              onClick={() => {
                const filled = slots.filter((s) => s.mic.trim() || s.member.trim());
                // drop rows that repeat a member already listed on this item.
                // (Mic numbers CAN repeat — mics get shared when guests run them out.)
                const seen = new Set<string>();
                const deduped = filled.filter((s) => {
                  const key = s.member.trim().toLowerCase();
                  if (!key) return true; // mic-only row — nothing to dedup
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                });
                const removed = filled.length - deduped.length;
                if (removed > 0)
                  toast.success(`รวมสมาชิกซ้ำ — ลบออก ${removed} รายการ`);
                onSave(deduped);
                setOpen(false);
              }}
            >
              บันทึกไมค์
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- pick a song from the group's library (dialog) ------------------------
function LibraryPickerDialog({
  songs,
  onPick,
}: {
  songs: Song[];
  onPick: (song: Song) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const filtered = songs.filter((s) =>
    s.title.toLowerCase().includes(q.trim().toLowerCase())
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <ListMusic className="h-4 w-4" /> จากคลัง
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>เลือกเพลงจากคลัง</DialogTitle>
        </DialogHeader>
        {songs.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            ยังไม่มีเพลงในคลังของวงนี้ — เพิ่มได้ที่เมนู “คลังเพลง”
          </p>
        ) : (
          <div className="space-y-2">
            <Input
              autoFocus
              placeholder="ค้นหาชื่อเพลง…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="max-h-72 space-y-1 overflow-auto">
              {filtered.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  ไม่พบเพลง
                </p>
              ) : (
                filtered.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                    onClick={() => {
                      onPick(s);
                      setQ("");
                      setOpen(false);
                    }}
                  >
                    <span className="font-medium">{s.title}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {s.duration_seconds
                        ? formatDuration(s.duration_seconds)
                        : "—"}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- main builder ----------------------------------------------------------
export function SetlistBuilder({
  eventId,
  tenantId,
  editable,
  initialItems,
  showStartTime,
  hardOutTime,
  members,
  songs,
}: {
  eventId: string;
  tenantId: string;
  editable: boolean;
  initialItems: SetlistItem[];
  showStartTime: string | null;
  hardOutTime: string | null;
  members: Member[];
  songs: Song[];
}) {
  const supabase = createClient();
  const [items, setItems] = useState<SetlistItem[]>(
    [...initialItems].sort((a, b) => a.sort_order - b.sort_order)
  );
  const dragIndex = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Live Mode sync: join the show channel so we can (a) tell a running Live Mode to
  // refetch when the setlist changes, and (b) learn which item is on air and lock it.
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [liveItemId, setLiveItemId] = useState<string | null>(null);
  useEffect(() => {
    const supabase = createClient();
    const ch = supabase.channel(`live:${eventId}`, {
      config: { broadcast: { self: false } },
    });
    // a running Live Mode broadcasts its state; lock the on-air row (only while begun)
    ch.on("broadcast", { event: "state" }, ({ payload }) => {
      if (!payload) return;
      setLiveItemId(payload.begun ? (payload.currentItemId ?? null) : null);
    });
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        // ask any running Live Mode for its current state (so we lock immediately)
        ch.send({
          type: "broadcast",
          event: "sync-request",
          payload: { sender: "setlist-builder" },
        });
      }
    });
    channelRef.current = ch;
    return () => {
      channelRef.current = null;
      supabase.removeChannel(ch);
    };
  }, [eventId]);

  // notify a running Live Mode to pull the updated setlist (after a successful write)
  function notifyLive() {
    channelRef.current?.send({
      type: "broadcast",
      event: "setlist-changed",
      payload: { at: Date.now() },
    });
  }

  const showStartSec = parseClockToSeconds(showStartTime);
  const hardOutSec = parseClockToSeconds(hardOutTime);
  const hasClock = showStartSec != null;

  const timing = useMemo(
    () => computeSetlistTimes(items, showStartSec ?? 0, hardOutSec),
    [items, showStartSec, hardOutSec]
  );

  function setLocal(id: string, partial: Partial<SetlistItem>) {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, ...partial } : it))
    );
  }

  async function persist(id: string, partial: Partial<SetlistItem>) {
    const { error } = await supabase
      .from("setlist_items")
      .update(partial)
      .eq("id", id);
    if (error) toast.error("บันทึกไม่สำเร็จ", { description: error.message });
    else notifyLive();
  }

  function update(id: string, partial: Partial<SetlistItem>) {
    setLocal(id, partial);
    persist(id, partial);
  }

  // Remember each item's duration right before "เวลาที่เหลือ" overwrote it, so the
  // user can undo and not lose a real song length (in-session; clears on reload).
  const [prevDuration, setPrevDuration] = useState<Record<string, number>>({});

  // Set this item's duration to all the time left until Hard Out (e.g. final MC).
  // startSec is this row's clock-of-day start (already includes its buffer_before).
  function fillRemaining(itemId: string, startSec: number, bufferAfter: number) {
    if (hardOutSec == null) return;
    const dur = Math.round(hardOutSec - Math.max(0, bufferAfter || 0) - startSec);
    if (dur <= 0) {
      toast.error("เวลาไม่พอ — รายการก่อนหน้าใช้เวลาเกิน Hard Out แล้ว", {
        description: "ลองลดความยาวรายการอื่นก่อน",
      });
      return;
    }
    const old = items.find((i) => i.id === itemId)?.duration_seconds ?? 0;
    setPrevDuration((p) => ({ ...p, [itemId]: old }));
    update(itemId, { duration_seconds: dur });
    toast.success(`ตั้งเป็นเวลาที่เหลือ ${formatDuration(dur)}`);
  }

  // Restore the duration captured before "เวลาที่เหลือ" was pressed.
  function restoreDuration(itemId: string) {
    const old = prevDuration[itemId];
    if (old == null) return;
    update(itemId, { duration_seconds: old });
    setPrevDuration((p) => {
      const n = { ...p };
      delete n[itemId];
      return n;
    });
    toast.success(`คืนความยาวเดิม ${formatDuration(old)}`);
  }

  async function insertItem(extra: Partial<SetlistItem> & { kind: SetlistKind }) {
    const sort = items.length
      ? Math.max(...items.map((i) => i.sort_order)) + 1
      : 1;
    const { data, error } = await supabase
      .from("setlist_items")
      .insert({
        tenant_id: tenantId,
        event_id: eventId,
        buffer_before_seconds: 0,
        buffer_after_seconds: 0,
        mic_slots: [],
        sort_order: sort,
        ...extra,
      })
      .select("*")
      .single();
    if (error || !data) {
      toast.error("เพิ่มไม่สำเร็จ", { description: error?.message });
      return;
    }
    setItems((prev) => [...prev, data as SetlistItem]);
    notifyLive();
  }

  async function addItem(kind: SetlistKind) {
    // titles prefill the kind label; all durations start at 0 (user fills the real time)
    const defaults: Record<SetlistKind, Partial<SetlistItem>> = {
      song: { title: "", duration_seconds: 0 },
      mc: { title: "MC", duration_seconds: 0 },
      se: { title: "SE", duration_seconds: 0 },
      instrument: { title: "Instrument", duration_seconds: 0 },
      interlude: { title: "Interlude", duration_seconds: 0 },
      guest: { title: "Guest", duration_seconds: 0 },
    };
    await insertItem({ kind, ...defaults[kind] });
  }

  /** Add a setlist row from a library song — auto-fills title + duration. */
  async function addFromLibrary(song: Song) {
    await insertItem({
      kind: "song",
      title: song.title,
      duration_seconds: song.duration_seconds,
    });
    toast.success(`เพิ่ม "${song.title}" จากคลังแล้ว`);
  }

  /** Clone a row (appended at the end — drag into place). Audio is not copied. */
  async function duplicateItem(it: SetlistItem) {
    await insertItem({
      kind: it.kind,
      title: it.title,
      duration_seconds: it.duration_seconds,
      buffer_before_seconds: it.buffer_before_seconds,
      buffer_after_seconds: it.buffer_after_seconds,
      mic_slots: it.mic_slots,
      notes: it.notes,
    });
    toast.success("ก๊อปรายการแล้ว — ลากไปจัดตำแหน่งได้");
  }

  async function removeItem(id: string) {
    const snapshot = items;
    const removed = snapshot.find((it) => it.id === id);
    setItems((prev) => prev.filter((it) => it.id !== id));
    const { error } = await supabase.from("setlist_items").delete().eq("id", id);
    if (error) {
      toast.error("ลบไม่สำเร็จ", { description: error.message });
      setItems(snapshot);
    } else {
      deleteAudio(eventId, id).catch(() => {}); // local cache
      if (removed?.audio_path) removeEventAudio(removed.audio_path).catch(() => {}); // online object
      notifyLive();
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
        .from("setlist_items")
        .update({ sort_order: b.sort_order })
        .eq("id", a.id),
      supabase
        .from("setlist_items")
        .update({ sort_order: a.sort_order })
        .eq("id", b.id),
    ]);
    notifyLive();
  }

  /** Drag & drop reorder (desktop): move the dragged row to `target` index. */
  async function handleDrop(target: number) {
    const from = dragIndex.current;
    dragIndex.current = null;
    setDragOverIndex(null);
    if (from == null || from === target) return;
    const prev = items;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    const renumbered = next.map((it, i) => ({ ...it, sort_order: i + 1 }));
    setItems(renumbered);
    const changed = renumbered.filter(
      (it) => prev.find((o) => o.id === it.id)?.sort_order !== it.sort_order
    );
    const results = await Promise.all(
      changed.map((it) =>
        supabase
          .from("setlist_items")
          .update({ sort_order: it.sort_order })
          .eq("id", it.id)
      )
    );
    const failed = results.find((r) => r.error);
    if (failed?.error) {
      toast.error("เรียงลำดับไม่สำเร็จ", { description: failed.error.message });
      setItems(prev);
    } else {
      notifyLive();
    }
  }

  return (
    <div className="space-y-4">
      {/* Summary / Hard-out banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <div>
            <p className="text-xs text-muted-foreground">เวลารวม (Run Time)</p>
            <p className="text-xl font-bold tabular-nums">
              {formatDuration(timing.totalSeconds)}
            </p>
          </div>
          {hasClock && (
            <div>
              <p className="text-xs text-muted-foreground">เริ่ม–จบ</p>
              <p className="font-semibold tabular-nums">
                {formatClockOfDay(showStartSec!)} –{" "}
                {formatClockOfDay(timing.endSec)}
              </p>
            </div>
          )}
          <div>
            <p className="text-xs text-muted-foreground">จำนวนรายการ</p>
            <p className="font-semibold tabular-nums">{items.length}</p>
          </div>
        </div>
        {hardOutSec != null &&
          (timing.isOver ? (
            <Badge variant="destructive" className="gap-1 px-3 py-1.5 text-sm">
              <AlarmClock className="h-4 w-4" /> เกิน Hard Out{" "}
              {formatDuration(timing.overBy)}
            </Badge>
          ) : (
            <Badge variant="success" className="gap-1 px-3 py-1.5 text-sm">
              <CheckCircle2 className="h-4 w-4" /> อยู่ในเวลา · เหลือ{" "}
              {formatDuration(Math.max(0, hardOutSec - timing.endSec))}
            </Badge>
          ))}
      </div>

      {items.length === 0 && (
        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          ยังไม่มีรายการในเซ็ตลิสต์
        </p>
      )}

      {/* Items */}
      <div className="space-y-2">
        {items.map((it, idx) => {
          const t = timing.rows[idx];
          // This row is on air in a running Live Mode → lock its edits (can't change
          // what's playing). Other rows stay editable and sync to Live Mode live.
          const isLive = liveItemId === it.id;
          const rowEditable = editable && !isLive;
          return (
            <div
              key={it.id}
              onDragOver={
                editable
                  ? (e) => {
                      e.preventDefault();
                      if (dragOverIndex !== idx) setDragOverIndex(idx);
                    }
                  : undefined
              }
              onDrop={editable ? () => handleDrop(idx) : undefined}
              onDragLeave={
                editable
                  ? () => setDragOverIndex((v) => (v === idx ? null : v))
                  : undefined
              }
              className={cn(
                "rounded-lg border bg-card p-3 shadow-sm",
                t?.overHardOut && "border-destructive/60 bg-destructive/5",
                dragOverIndex === idx && "ring-2 ring-primary",
                isLive && "border-rose-400 ring-2 ring-rose-400/60"
              )}
            >
              {isLive && (
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-rose-600">
                  <Radio className="h-3.5 w-3.5 animate-pulse" />
                  กำลังเล่นอยู่บนเวที — ล็อกแก้ไขชั่วคราว
                </div>
              )}
              <div className="flex items-center gap-2">
                {rowEditable && (
                  <button
                    type="button"
                    draggable
                    onDragStart={() => {
                      dragIndex.current = idx;
                    }}
                    onDragEnd={() => {
                      dragIndex.current = null;
                      setDragOverIndex(null);
                    }}
                    className="shrink-0 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
                    aria-label="ลากเพื่อย้ายลำดับ"
                  >
                    <GripVertical className="h-4 w-4" />
                  </button>
                )}
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-muted text-xs font-semibold tabular-nums">
                  {idx + 1}
                </span>
                <div className="w-[88px] shrink-0">
                  <Select
                    value={it.kind}
                    disabled={!rowEditable}
                    onValueChange={(v) => update(it.id, { kind: v as SetlistKind })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {KIND_KEYS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {SETLIST_KIND_SHORT[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  className="flex-1"
                  value={it.title}
                  disabled={!rowEditable}
                  placeholder="ชื่อเพลง / หัวข้อ"
                  onChange={(e) => setLocal(it.id, { title: e.target.value })}
                  onBlur={(e) => persist(it.id, { title: e.target.value })}
                />
                {rowEditable && (
                  <div className="flex shrink-0">
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
                      title="ก๊อปรายการนี้"
                      onClick={() => duplicateItem(it)}
                    >
                      <Copy className="h-4 w-4" />
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
                  </div>
                )}
              </div>

              {/* Timing line */}
              <div
                className={cn(
                  "mt-2 flex flex-wrap items-center gap-x-4 gap-y-0.5 pl-8 text-xs tabular-nums text-muted-foreground",
                  t?.overHardOut && "text-destructive"
                )}
              >
                {hasClock && (
                  <span>
                    เริ่ม <b className="font-semibold">{formatClockOfDay(t.startSec)}</b> · จบ{" "}
                    <b className="font-semibold">{formatClockOfDay(t.endSec)}</b>
                  </span>
                )}
                <span>
                  ความยาว {formatDuration(it.duration_seconds)}
                </span>
                <span>สะสม {formatDuration(t?.accumulatedSec ?? 0)}</span>
              </div>

              {/* Editable fields */}
              <div className="mt-2 grid gap-2 pl-8 sm:grid-cols-12">
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">
                    ความยาว (m:ss)
                  </Label>
                  <DurationField
                    seconds={it.duration_seconds}
                    disabled={!rowEditable}
                    onCommit={(s) => update(it.id, { duration_seconds: s })}
                  />
                  {/* "เวลาที่เหลือ" only on the LAST item — it fills to Hard Out, which
                      only makes sense for the closing row (e.g. final MC). */}
                  {rowEditable &&
                    hardOutSec != null &&
                    t &&
                    idx === items.length - 1 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          fillRemaining(it.id, t.startSec, it.buffer_after_seconds)
                        }
                        title="ตั้งความยาว = เวลาที่เหลือจนถึง Hard Out (เช่น MC ปิดท้าย)"
                        className="h-8 w-full gap-1 text-xs"
                      >
                        <AlarmClock className="h-3.5 w-3.5" /> เวลาที่เหลือ
                      </Button>
                    )}
                  {/* undo — restore the duration from before "เวลาที่เหลือ" was pressed */}
                  {rowEditable && prevDuration[it.id] != null && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => restoreDuration(it.id)}
                      title="คืนความยาวก่อนกด 'เวลาที่เหลือ'"
                      className="h-8 w-full gap-1 text-xs text-muted-foreground"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> คืนค่าเดิม{" "}
                      {formatDuration(prevDuration[it.id])}
                    </Button>
                  )}
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">
                    เล่นซ้อน (วิ · เริ่มก่อนเพลงก่อนจบ)
                  </Label>
                  <Input
                    type="number"
                    max={0}
                    min={-300}
                    placeholder="เช่น -5"
                    className="tabular-nums"
                    value={it.buffer_before_seconds}
                    disabled={!rowEditable}
                    onChange={(e) =>
                      setLocal(it.id, {
                        buffer_before_seconds: Math.min(0, Number(e.target.value) || 0),
                      })
                    }
                    onBlur={(e) =>
                      persist(it.id, {
                        buffer_before_seconds: Math.min(0, Number(e.target.value) || 0),
                      })
                    }
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">
                    เผื่อเวลาหลัง (วิ)
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    className="tabular-nums"
                    value={it.buffer_after_seconds}
                    disabled={!rowEditable}
                    onChange={(e) =>
                      setLocal(it.id, {
                        buffer_after_seconds: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                    onBlur={(e) =>
                      persist(it.id, {
                        buffer_after_seconds: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                  />
                </div>
                <div className="space-y-1 sm:col-span-6">
                  <Label className="text-xs text-muted-foreground">ไมค์ + สมาชิก</Label>
                  <MicSlotsDialog
                    item={it}
                    members={members}
                    disabled={!rowEditable}
                    onSave={(slots) => update(it.id, { mic_slots: slots })}
                  />
                </div>
              </div>

              {(rowEditable || it.notes) && (
                <div className="mt-2 pl-8">
                  <Input
                    value={it.notes ?? ""}
                    disabled={!rowEditable}
                    placeholder="โน้ต (เช่น โปรย confetti, เปลี่ยนชุด)"
                    onChange={(e) => setLocal(it.id, { notes: e.target.value })}
                    onBlur={(e) =>
                      persist(it.id, { notes: e.target.value.trim() || null })
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="default" onClick={() => addItem("song")}>
            <Plus className="h-4 w-4" /> เพลง
          </Button>
          <LibraryPickerDialog songs={songs} onPick={addFromLibrary} />
          <Button type="button" variant="outline" onClick={() => addItem("mc")}>
            <Plus className="h-4 w-4" /> MC
          </Button>
          <Button type="button" variant="outline" onClick={() => addItem("se")}>
            <Plus className="h-4 w-4" /> SE
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => addItem("instrument")}
          >
            <Plus className="h-4 w-4" /> Instrument
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => addItem("interlude")}
          >
            <Plus className="h-4 w-4" /> Interlude
          </Button>
          <Button type="button" variant="outline" onClick={() => addItem("guest")}>
            <Plus className="h-4 w-4" /> Guest
          </Button>
        </div>
      )}
    </div>
  );
}
