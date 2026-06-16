"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ChevronUp,
  ChevronDown,
  Trash2,
  Plus,
  Mic,
  AlarmClock,
  CheckCircle2,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
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
                {members.map((m) => (
                  <Button
                    key={m.id}
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-7"
                    onClick={() =>
                      setSlots((prev) => [
                        ...prev,
                        {
                          mic: m.mic_number != null ? String(m.mic_number) : "",
                          member: m.nickname || m.name,
                        },
                      ])
                    }
                  >
                    {m.mic_number != null ? `${m.mic_number} ` : ""}
                    {m.nickname || m.name}
                  </Button>
                ))}
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
                onSave(slots.filter((s) => s.mic.trim() || s.member.trim()));
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

// ---- main builder ----------------------------------------------------------
export function SetlistBuilder({
  eventId,
  tenantId,
  editable,
  initialItems,
  showStartTime,
  hardOutTime,
  members,
}: {
  eventId: string;
  tenantId: string;
  editable: boolean;
  initialItems: SetlistItem[];
  showStartTime: string | null;
  hardOutTime: string | null;
  members: Member[];
}) {
  const supabase = createClient();
  const [items, setItems] = useState<SetlistItem[]>(
    [...initialItems].sort((a, b) => a.sort_order - b.sort_order)
  );

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
  }

  function update(id: string, partial: Partial<SetlistItem>) {
    setLocal(id, partial);
    persist(id, partial);
  }

  async function addItem(kind: SetlistKind) {
    const sort = items.length
      ? Math.max(...items.map((i) => i.sort_order)) + 1
      : 1;
    const defaults: Record<SetlistKind, Partial<SetlistItem>> = {
      song: { title: "", duration_seconds: 210 },
      mc: { title: "MC", duration_seconds: 180 },
      se: { title: "SE", duration_seconds: 30 },
      interlude: { title: "Interlude", duration_seconds: 60 },
      guest: { title: "Guest", duration_seconds: 120 },
    };
    const { data, error } = await supabase
      .from("setlist_items")
      .insert({
        tenant_id: tenantId,
        event_id: eventId,
        kind,
        buffer_before_seconds: 0,
        buffer_after_seconds: 3,
        mic_slots: [],
        sort_order: sort,
        ...defaults[kind],
      })
      .select("*")
      .single();
    if (error || !data) {
      toast.error("เพิ่มไม่สำเร็จ", { description: error?.message });
      return;
    }
    setItems((prev) => [...prev, data as SetlistItem]);
  }

  async function removeItem(id: string) {
    const snapshot = items;
    setItems((prev) => prev.filter((it) => it.id !== id));
    const { error } = await supabase.from("setlist_items").delete().eq("id", id);
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
        .from("setlist_items")
        .update({ sort_order: b.sort_order })
        .eq("id", a.id),
      supabase
        .from("setlist_items")
        .update({ sort_order: a.sort_order })
        .eq("id", b.id),
    ]);
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
          return (
            <div
              key={it.id}
              className={cn(
                "rounded-lg border bg-card p-3 shadow-sm",
                t?.overHardOut && "border-destructive/60 bg-destructive/5"
              )}
            >
              <div className="flex items-center gap-2">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-muted text-xs font-semibold tabular-nums">
                  {idx + 1}
                </span>
                <div className="w-[88px] shrink-0">
                  <Select
                    value={it.kind}
                    disabled={!editable}
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
                  disabled={!editable}
                  placeholder="ชื่อเพลง / หัวข้อ"
                  onChange={(e) => setLocal(it.id, { title: e.target.value })}
                  onBlur={(e) => persist(it.id, { title: e.target.value })}
                />
                {editable && (
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
                <div className="space-y-1 sm:col-span-3">
                  <Label className="text-xs text-muted-foreground">
                    ความยาว (m:ss)
                  </Label>
                  <DurationField
                    seconds={it.duration_seconds}
                    disabled={!editable}
                    onCommit={(s) => update(it.id, { duration_seconds: s })}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">
                    Buffer ก่อน (วิ)
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    className="tabular-nums"
                    value={it.buffer_before_seconds}
                    disabled={!editable}
                    onChange={(e) =>
                      setLocal(it.id, {
                        buffer_before_seconds: Number(e.target.value) || 0,
                      })
                    }
                    onBlur={(e) =>
                      persist(it.id, {
                        buffer_before_seconds: Number(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">
                    Buffer หลัง (วิ)
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    className="tabular-nums"
                    value={it.buffer_after_seconds}
                    disabled={!editable}
                    onChange={(e) =>
                      setLocal(it.id, {
                        buffer_after_seconds: Number(e.target.value) || 0,
                      })
                    }
                    onBlur={(e) =>
                      persist(it.id, {
                        buffer_after_seconds: Number(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <div className="space-y-1 sm:col-span-5">
                  <Label className="text-xs text-muted-foreground">ไมค์ + สมาชิก</Label>
                  <MicSlotsDialog
                    item={it}
                    members={members}
                    disabled={!editable}
                    onSave={(slots) => update(it.id, { mic_slots: slots })}
                  />
                </div>
              </div>

              {(editable || it.notes) && (
                <div className="mt-2 pl-8">
                  <Input
                    value={it.notes ?? ""}
                    disabled={!editable}
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
          <Button type="button" variant="outline" onClick={() => addItem("mc")}>
            <Plus className="h-4 w-4" /> MC
          </Button>
          <Button type="button" variant="outline" onClick={() => addItem("se")}>
            <Plus className="h-4 w-4" /> SE
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => addItem("interlude")}
          >
            <Plus className="h-4 w-4" /> Interlude
          </Button>
        </div>
      )}
    </div>
  );
}
