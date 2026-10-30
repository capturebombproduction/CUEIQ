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
  Check,
  ListMusic,
  GripVertical,
  OctagonAlert,
  RotateCcw,
  Music2,
  Repeat,
  X,
} from "lucide-react";
import { KindTile } from "@/components/event/kind";
import { TimingInput } from "@/components/event/timing-input";
import { RunMeter } from "@/components/event/run-meter";
import { createClient } from "@/lib/supabase/client";
import { isQueueableWriteError, newLocalRowId } from "@/lib/mgmt-outbox";
import { hasRunOrderTie } from "@/lib/run-order-sort";
import {
  OFFLINE_QUEUED_MESSAGE,
  QUEUED_BEHIND_PENDING_MESSAGE,
  tryQueueBehindPendingChildList,
  tryQueueChildList,
} from "@/lib/mgmt-write";
import { deleteAudio } from "@/lib/audio-store";
import { removeEventAudio } from "@/lib/audio-remote";
import {
  SetlistVersions,
  type SnapshotItem,
} from "@/components/event/setlist-versions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { liveTopic, privateChannel } from "@/lib/realtime";
import { noRowsMessage, wroteNothing, writeErrorText } from "@/lib/write-guard";
import { SaveStatus, useSaveSignal } from "@/components/event/save-status";
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
  foldWaitsIntoNext,
  TIMING_LABEL,
  timingMeaning,
  formatDuration,
  parseClockToSeconds,
  parseDurationToSeconds,
  formatClockOfDay,
} from "@/lib/time";

const KIND_KEYS = Object.keys(SETLIST_KIND_LABELS) as SetlistKind[];

/** How long the read-back of an insert whose answer was lost may take (insertLanded). */
const READ_BACK_TIMEOUT_MS = 4000;

/**
 * Did an insert that got NO HTTP answer land anyway? (2026-10-30, hunt 11)
 *
 * On venue Wi-Fi the request can reach the server and its answer be lost on the way back (a
 * phone hopping from Wi-Fi to cellular, a roam between access points): supabase-js then says
 * "TypeError: Failed to fetch" with status 0. That read as "เพิ่มไม่สำเร็จ", the row was not
 * on screen, the user tapped again - and the server held the song twice, which Live Mode then
 * played twice. The insert now carries the id it was minted with, so one bounded read of that
 * id tells. Only for a write with no answer at all: a real HTTP answer (a 4xx, a 5xx) is
 * judged exactly as before. Rows when EVERY id is there, else null - and null keeps the caller
 * on its old path. An empty answer proves nothing more than that (sent as anon, RLS reads 0
 * rows with no error), so it is never read as "not there" beyond keeping today's path.
 */
async function insertLanded<T>(
  supabase: ReturnType<typeof createClient>,
  ids: string[],
  error: { message?: string | null } | null,
  status: number | null | undefined
): Promise<T[] | null> {
  if (typeof status === "number" && status > 0) return null;
  if (!isQueueableWriteError(error?.message, true, status)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      supabase.from("setlist_items").select("*").in("id", ids),
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), READ_BACK_TIMEOUT_MS);
      }),
    ]);
    if (!res || res.error || !Array.isArray(res.data) || res.data.length !== ids.length) return null;
    return res.data as T[];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- m:ss duration field with its own text buffer --------------------------
function DurationField({
  id,
  seconds,
  disabled,
  onCommit,
}: {
  /** so a <Label htmlFor> can name the field */
  id?: string;
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
      id={id}
      value={text}
      disabled={disabled}
      // NOT inputMode="numeric": iOS renders that as a bare 0-9 keypad with no
      // colon, so on an iPad the one format this field asks for cannot be typed.
      // Worse, the fallback people reach for is silently wrong — parse reads a
      // lone number as SECONDS, so "345" meaning 3:45 commits 5:45 with no error.
      inputMode="text"
      placeholder="m:ss"
      className="num"
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

// ---- Mic Preset helpers (localStorage, per-event) --------------------------
/** Cut a long title for a one-line mention (song titles here run to 80+ chars). */
function clip(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n - 1).join("") + "…" : s;
}

function presetKey(eventId: string) {
  return `cueiq:mic-preset:${eventId}`;
}
function loadPreset(eventId: string): MicSlot[] {
  try {
    const raw = localStorage.getItem(presetKey(eventId));
    return raw ? (JSON.parse(raw) as MicSlot[]) : [];
  } catch {
    return [];
  }
}
function savePreset(eventId: string, slots: MicSlot[]) {
  try {
    localStorage.setItem(presetKey(eventId), JSON.stringify(slots));
  } catch {}
}

// ---- per-item mic slot editor (dialog) -------------------------------------
function MicSlotsDialog({
  item,
  eventId,
  members,
  disabled,
  onSave,
}: {
  item: SetlistItem;
  eventId: string;
  members: Member[];
  disabled?: boolean;
  onSave: (slots: MicSlot[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState<MicSlot[]>(item.mic_slots ?? []);
  const [preset, setPreset] = useState<MicSlot[]>([]);

  // Load preset from localStorage when dialog opens.
  useEffect(() => {
    if (open) {
      setSlots(item.mic_slots ?? []);
      setPreset(loadPreset(eventId));
    }
  }, [open, item.mic_slots, eventId]);

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

        {/* Preset bar — visible only when editing */}
        {!disabled && (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <span className="text-xs text-muted-foreground">Preset:</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={slots.filter((s) => s.mic.trim() || s.member.trim()).length === 0}
              onClick={() => {
                const filled = slots.filter((s) => s.mic.trim() || s.member.trim());
                savePreset(eventId, filled);
                setPreset(filled);
                toast.success("บันทึก Preset ไมค์แล้ว");
              }}
            >
              บันทึกเป็น Preset
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={preset.length === 0}
              title={preset.length === 0 ? "ยังไม่มี Preset — กด 'บันทึกเป็น Preset' ก่อน" : undefined}
              onClick={() => {
                setSlots(preset.map((s) => ({ ...s })));
                toast.success("ใช้ Preset ไมค์แล้ว");
              }}
            >
              ใช้ Preset
              {preset.length > 0 && (
                <Badge variant="secondary" className="ml-1.5">{preset.length}</Badge>
              )}
            </Button>
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
  disabled,
  inSet,
  open: openProp,
  onOpenChange,
  heading = "เลือกเพลงจากคลัง",
  hint,
  returnFocusTo,
}: {
  songs: Song[];
  onPick: (song: Song) => void;
  disabled?: boolean;
  /** song ids already in this setlist — marked, never blocked (a set can repeat a song). */
  inSet?: ReadonlySet<string>;
  /** Controlled: no trigger button is rendered; the caller opens it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  heading?: string;
  hint?: string;
  /** Controlled mode has no trigger for Radix to hand focus back to on close. */
  returnFocusTo?: () => HTMLElement | null;
}) {
  const [openState, setOpenState] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : openState;
  const setOpen = (o: boolean) => {
    if (!o) setQ("");
    if (controlled) onOpenChange?.(o);
    else setOpenState(o);
  };
  const [q, setQ] = useState("");
  const filtered = songs.filter((s) =>
    s.title.toLowerCase().includes(q.trim().toLowerCase())
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!controlled && (
        <DialogTrigger asChild>
          <Button type="button" variant="outline" disabled={disabled}>
            <ListMusic className="h-4 w-4" /> จากคลัง
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        onCloseAutoFocus={(e) => {
          const el = returnFocusTo?.();
          if (el) {
            e.preventDefault();
            el.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          {hint && <DialogDescription>{hint}</DialogDescription>}
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
                    disabled={disabled}
                    className="flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => {
                      // An add is still round-tripping — the pick would be dropped.
                      if (disabled) return;
                      onPick(s);
                      setQ("");
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{s.title}</span>
                      {inSet?.has(s.id) && (
                        <span className="ml-2 whitespace-nowrap text-xs text-muted-foreground">
                          · อยู่ในเซ็ตแล้ว
                        </span>
                      )}
                    </span>
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
  eventName,
}: {
  eventId: string;
  tenantId: string;
  editable: boolean;
  initialItems: SetlistItem[];
  showStartTime: string | null;
  hardOutTime: string | null;
  members: Member[];
  songs: Song[];
  eventName?: string;
}) {
  const supabase = createClient();
  const confirm = useConfirm();
  // This builder has autosaved on blur since 2026-06-16 and never said so; the
  // label asked twice for the feature it already had. See save-status.tsx.
  const save = useSaveSignal();
  const [items, setItems] = useState<SetlistItem[]>(
    [...initialItems].sort((a, b) => a.sort_order - b.sort_order)
  );
  // The setlist as the SERVER holds it - or will, once what this builder queued
  // offline has landed. It is the offline snapshot's base (the flush's online-wins
  // guard compares the server against it), and it must not be `items`: the title,
  // timing and note fields setLocal on every keystroke and persist on blur, so when a
  // blur's write fails `items` already holds the edit - base == rows, and the flush
  // parked the venue's own edit as "เวอร์ชันออนไลน์ถูกแก้ไขใหม่กว่าของเครื่องนี้" although
  // nobody touched the online copy (planEnqueue keeps that first base, so every later
  // offline edit of the night parked with it). Advanced only by a write the server
  // acknowledged - with what was WRITTEN (a note is saved trimmed, kept raw on screen)
  // - by a read of the server, and by a snapshot that was queued (the list the server
  // will hold once the flush lands it; without that, the next offline edit after a
  // flush would be based on the list from before it and park).
  const ackedRef = useRef<SetlistItem[]>(items);
  function ackRow(id: string, partial: Partial<SetlistItem>) {
    ackedRef.current = ackedRef.current.map((it) => (it.id === id ? { ...it, ...partial } : it));
  }
  const dragIndex = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  // add-in-flight: ref blocks re-entry immediately, state disables the buttons
  const insertingRef = useRef(false);
  const [inserting, setInserting] = useState(false);
  // Ids minted client-side (newLocalRowId) for a row that only exists in the
  // offline outbox so far — its row has no server counterpart until the flush
  // lands, so a direct UPDATE by this id legitimately matches 0 rows. Batch
  // writes below must not read that as a failed write. Reconciling with the
  // server (reconcileFromServer) drops an id once its row shows up there.
  const localOnlyIds = useRef<Set<string>>(new Set());

  // Live Mode sync: join the show channel so we can (a) tell a running Live Mode to
  // refetch when the setlist changes, and (b) learn which item is on air and lock it.
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [liveItemId, setLiveItemId] = useState<string | null>(null);
  // The same value for code that AWAITS (the delete's confirm sheet, a restore): what
  // a handler closed over is the state from before the show moved on.
  const liveItemIdRef = useRef<string | null>(null);
  useEffect(() => {
    const supabase = createClient();
    const ch = privateChannel(supabase, liveTopic(eventId));
    // a running Live Mode broadcasts its state; lock the on-air row (only while begun)
    ch.on("broadcast", { event: "state" }, ({ payload }) => {
      if (!payload) return;
      // จบโชว์ keeps `begun` true on purpose (live-mode.tsx statePayload) and says so in
      // `ended`: an ended show holds no row on air, so restores and the row it stopped
      // on were refused until someone pressed reset in Live (2026-10-27).
      const onAir = payload.begun && !payload.ended ? (payload.currentItemId ?? null) : null;
      liveItemIdRef.current = onAir;
      setLiveItemId(onAir);
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

  // Restore a saved snapshot: insert the snapshot rows first (so a failure leaves
  // the current setlist intact), then delete the old rows + their audio.
  async function restoreSnapshot(snapshot: SnapshotItem[]) {
    // A restore replaces EVERY row with fresh ids - the one on air included, so a
    // running Live Mode would lose the song it is playing. The version list's confirm
    // can sit open while the show moves on, so this is read now, after it.
    if (liveItemIdRef.current) {
      throw new Error(
        "โชว์กำลังเล่นอยู่ — การกู้คืนจะแทนที่แถวที่กำลังเล่นอยู่บนเวทีด้วย รอให้จบโชว์ก่อนค่อยกู้คืน"
      );
    }
    const old = items;
    let inserted: SetlistItem[] = [];
    // song_id survives the snapshot (it's what makes the row playable), but a
    // song deleted SINCE the save would violate the FK on insert (on-delete-
    // set-null only nulls live rows) — restore those as unlinked instead.
    // `songs` is the library as this page loaded it: a song another device added since
    // read as "deleted" and came back unlinked - a row that plays nothing in Live
    // (2026-10-27). So the ids this page does not know are asked of the SERVER (only
    // those: every other restore stays one round trip). No answer (offline) → unlinked.
    const libraryIds = new Set(songs.map((s) => s.id));
    const unknown = Array.from(
      new Set(snapshot.map((s) => s.song_id).filter((id): id is string => !!id && !libraryIds.has(id)))
    );
    if (unknown.length) {
      const { data: found, error: foundErr } = await supabase.from("songs").select("id").in("id", unknown);
      if (!foundErr && found) for (const s of found as { id: string }[]) libraryIds.add(s.id);
    }
    // a version saved with the old "เผื่อเวลาหลัง" comes back as the one ตั้งเวลา field
    const rows = foldWaitsIntoNext(snapshot).map(({ song_id, ...s }) => ({
      tenant_id: tenantId,
      event_id: eventId,
      ...s,
      song_id: song_id && libraryIds.has(song_id) ? song_id : null,
    }));
    // The rows as a queued restore holds them: minted locally (stable client ids).
    const minted = rows.map((r) => mintLocalItem(r.sort_order, { ...r }));
    // This setlist already waits in the offline queue: the restore joins it there
    // (see queueBehindPending), exactly as the offline path below.
    if (await queueBehindPending(minted)) {
      old.forEach((it) => deleteAudio(eventId, it.id).catch(() => {}));
      minted.forEach((m) => localOnlyIds.current.add(m.id));
      setItems([...minted].sort((a, b) => a.sort_order - b.sort_order));
      return;
    }
    if (rows.length) {
      const { data, error, status } = await supabase
        .from("setlist_items")
        .insert(rows)
        .select("*");
      if (error) {
        // Offline restore: queue the whole minted list — flush lands the restore
        // (or parks it if online changed first).
        if (await queueOffline(minted, error.message, status)) {
          old.forEach((it) => deleteAudio(eventId, it.id).catch(() => {}));
          minted.forEach((m) => localOnlyIds.current.add(m.id));
          setItems([...minted].sort((a, b) => a.sort_order - b.sort_order));
          return;
        }
        throw error;
      }
      inserted = data as SetlistItem[];
    }
    if (old.length) {
      // Ask for the removed rows back, like every other write in this file. A
      // delete that reported no error but touched NO ROW did not happen (sent as
      // anon after a failed token refresh), and by this point the snapshot rows
      // are already inserted — walking on would leave the original setlist PLUS a
      // full duplicate, with no unique constraint on (event_id, sort_order) to
      // stop it, and that is what the printed run sheet and Live Mode would then
      // use. See lib/write-guard.ts.
      const { data: deleted, error, status: deleteStatus } = await supabase
        .from("setlist_items")
        .delete()
        .in(
          "id",
          old.map((it) => it.id)
        )
        .select("id");
      if (error && inserted.length === 0) {
        // Restoring an EMPTY snapshot offline: queue "clear the setlist".
        if (await queueOffline([], error.message, deleteStatus)) {
          old.forEach((it) => deleteAudio(eventId, it.id).catch(() => {}));
          setItems([]);
          return;
        }
      }
      // A 0-row delete of rows that only exist in the offline outbox so far
      // (localOnlyIds) is expected, not a failure — the same rule the reorder
      // writes below already apply to their own 0-row results. The band edited
      // the setlist offline in the van, so those rows were minted locally and the
      // flush has not landed (or has parked as a conflict): the server has NO row
      // under those ids to delete. Judging that as a miss sends the rollback below
      // to take the snapshot rows that DID insert correctly back out again, and on
      // this no-undo path that is the restore destroying its own result.
      //
      // KNOWN LIMIT, recorded rather than papered over. The reorder writes below
      // clear a stale flag from their own evidence first ("this row DID write, so
      // it is on the server whatever the set says"). That step cannot help HERE and
      // is deliberately absent: this is one batch delete, so its evidence is
      // all-or-nothing — a non-empty `deleted` already makes `missed` false on the
      // next line, and an empty one clears nothing. So the one case the exclusion
      // cannot tell apart survives: EVERY old row flagged local-only, the outbox
      // has since flushed (the rows really are on the server under those same ids,
      // and nothing here listens for the flush), and the delete then 0-rows for
      // real as anon → `attempted` is empty, the guard is skipped, and the setlist
      // is left duplicated. Distinguishing it needs a server read or a flush
      // subscription, i.e. new plumbing on the path round 10 deliberately made
      // lenient; the two directions that ARE decidable are pinned in
      // setlist-builder.restore.test.tsx. Do not "fix" this by copying the reorder's
      // clear-from-evidence line here — it compiles, reads like a repair, and
      // changes nothing.
      const attempted = old.filter((it) => !localOnlyIds.current.has(it.id));
      // Same outcome for the caller, different cause: `missed` reached the server
      // and changed nothing, so there is no error to classify or queue — but it
      // leaves exactly the duplicate state the rollback below exists to undo.
      // One real server row among the old ones is enough: it should have come back.
      const missed = !error && attempted.length > 0 && wroteNothing(deleted);
      if (error || missed) {
        // The snapshot rows are already in; deleting the old ones failed → roll the
        // insert back so we don't leave BOTH sets (duplicates). Original setlist intact.
        if (inserted.length) {
          const { data: rolledBack, error: rollbackError } = await supabase
            .from("setlist_items")
            .delete()
            .in("id", inserted.map((it) => it.id))
            .select("id");
          // The rollback carries the identical hole: a 0-row delete has undone
          // nothing, so the duplicates are still there and the user must be told.
          // It needs no localOnlyIds filter of its own, and adding one would be
          // wrong: `inserted` only ever holds rows the server itself just handed
          // back (the offline insert path returned above), so every id here has a
          // real row and a 0-row answer is always a genuine miss.
          if (rollbackError || wroteNothing(rolledBack)) {
            // Net died mid-restore: the DB likely holds old + restored rows. Queue
            // the restored list with base = that combined state, so flush replace-
            // sets the duplicates away (or parks a conflict if online moved on).
            // Only a real transport failure can be queued — a 0-row result proves
            // the request reached the server, and there is no message to classify.
            const queued = error
              ? await tryQueueChildList({
                  kind: "setlist.upsert",
                  eventId,
                  tenantId,
                  eventName,
                  rows: inserted,
                  baseRows: [...old, ...inserted],
                  errorMessage: error.message,
                  status: deleteStatus,
                })
              : false;
            if (queued) {
              ackedRef.current = inserted; // what the server holds once the flush lands
              toast.success(OFFLINE_QUEUED_MESSAGE, { id: "mgmt-offline-queued" });
              old.forEach((it) => deleteAudio(eventId, it.id).catch(() => {}));
              setItems([...inserted].sort((a, b) => a.sort_order - b.sort_order));
              return;
            }
            // Can't queue (web / real rejection): show reality — refetch so the UI
            // matches the duplicated DB instead of silently hiding the extra rows.
            const { data: current } = await supabase
              .from("setlist_items")
              .select("*")
              .eq("event_id", eventId)
              .order("sort_order", { ascending: true })
              .order("id", { ascending: true }); // ties read the same as Live (lib/queries.ts)
            if (current) {
              // These rows are now authoritative — any that were still marked
              // local-only have a server counterpart, so a future batch write
              // hitting them for real is no longer a legitimate 0-row match.
              current.forEach((it) => localOnlyIds.current.delete(it.id));
              ackedRef.current = current as SetlistItem[];
              setItems(current as SetlistItem[]);
            }
            throw new Error(
              "ลบเซ็ตลิสต์เดิมไม่สำเร็จ — ตอนนี้อาจมีรายการซ้ำอยู่ กรุณาตรวจสอบและลบรายการที่ซ้ำออก"
            );
          }
        }
        // Rolled back cleanly (or there was nothing to roll back): the server still
        // holds the original setlist, which is what's already on screen. Say why
        // the restore didn't happen instead of reporting a success.
        if (error) throw error;
        throw new Error(await noRowsMessage());
      }
      old.forEach((it) => {
        deleteAudio(eventId, it.id).catch(() => {});
        // only legacy ad-hoc per-item audio is the item's to delete; a library-linked
        // item (song_id) shares the song's file — leave it to the library.
        if (it.audio_path && !it.song_id) removeEventAudio(it.audio_path).catch(() => {});
      });
    }
    ackedRef.current = inserted;
    setItems(inserted.sort((a, b) => a.sort_order - b.sort_order));
    notifyLive();
  }

  const showStartSec = parseClockToSeconds(showStartTime);
  const hardOutSec = parseClockToSeconds(hardOutTime);
  const hasClock = showStartSec != null;

  // The hard out only judges a set that has a start (2026-10-30, hunt 11), as on the Summary
  // (event-summary.tsx): without one the set runs from 00:00, and a 20-minute set against a
  // 13:40 hard out read a green "อยู่ในเวลา · เหลือ 13:20:00" - about a start nobody entered.
  const timing = useMemo(
    () => computeSetlistTimes(items, showStartSec ?? 0, hasClock ? hardOutSec : null),
    [items, showStartSec, hasClock, hardOutSec]
  );

  function setLocal(id: string, partial: Partial<SetlistItem>) {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, ...partial } : it))
    );
  }

  // ⭐#1 step 5: a write that failed on a DEAD NETWORK (or a 5xx/429 from a server
  // that is up - pass the response's `status`) queues the whole post-edit setlist as
  // one offline snapshot and returns true — keep the optimistic state (no
  // notifyLive: the realtime channel is down with the network anyway). Web (no
  // sink) / real rejections return false → the original error handling runs.
  // The guard's base is ackedRef (the server's list), never `items` - see there.
  async function queueOffline(
    next: SetlistItem[],
    errorMessage: string | null | undefined,
    status?: number | null
  ): Promise<boolean> {
    const queued = await tryQueueChildList({
      kind: "setlist.upsert",
      eventId,
      tenantId,
      eventName,
      rows: next,
      baseRows: ackedRef.current,
      errorMessage: errorMessage ?? null,
      status: status ?? null,
    });
    if (queued) {
      ackedRef.current = next;
      toast.success(OFFLINE_QUEUED_MESSAGE, { id: "mgmt-offline-queued" });
    }
    return queued;
  }

  // Desktop: while a snapshot of this setlist still waits in the offline queue, an
  // edit made after the net came back must join it, not write online - the queued
  // snapshot is based on the server list from before it, and this person's own
  // online write would make the flush park her queued edit as "เวอร์ชันออนไลน์ถูก
  // แก้ไขใหม่กว่าของเครื่องนี้" (lib/mgmt-write.ts tryQueueBehindPendingChildList).
  // Called BEFORE each online write; true = queued, the caller stops there.
  async function queueBehindPending(next: SetlistItem[]): Promise<boolean> {
    const queued = await tryQueueBehindPendingChildList({
      kind: "setlist.upsert",
      eventId,
      tenantId,
      eventName,
      rows: next,
      baseRows: ackedRef.current,
    });
    if (queued) {
      ackedRef.current = next;
      toast.success(QUEUED_BEHIND_PENDING_MESSAGE, { id: "mgmt-offline-queued" });
    }
    return queued;
  }

  async function persist(id: string, partial: Partial<SetlistItem>) {
    save.begin();
    try {
      await persistInner(id, partial);
    } catch (e) {
      // supabase-js reports nearly everything through `error`, but a fetch that
      // THROWS (offline mid-flight, an aborted request) used to escape here: the
      // badge stayed on กำลังบันทึก… forever, no toast appeared, and — since 0043 —
      // the leave-the-page warning would have counted that write as in flight for
      // the rest of the session.
      save.end(false);
      toast.error("บันทึกไม่สำเร็จ", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }

  async function persistInner(id: string, partial: Partial<SetlistItem>) {
    const next = items.map((it) => (it.id === id ? { ...it, ...partial } : it));
    if (await queueBehindPending(next)) {
      save.end(true);
      return;
    }
    const { data, error, status } = await supabase
      .from("setlist_items")
      .update(partial)
      .eq("id", id)
      .select("id");
    if (error) {
      // Queued offline IS saved — it is on disk and it will flush. Saying
      // "ยังไม่ได้บันทึก" for a venue with no wifi would be the wrong receipt.
      if (await queueOffline(next, error.message, status)) {
        save.end(true);
        return;
      }
      save.end(false);
      toast.error("บันทึกไม่สำเร็จ", { description: writeErrorText(error) });
      return;
    }
    // No error and no row = the write reached the server and changed nothing
    // (sent as anon after a failed token refresh, or the row is gone). Every edit
    // in this builder autosaves on blur, so staying silent here means a whole
    // session of durations, reordering and mic slots sits on screen looking saved
    // and is simply not there — discovered at the venue. See lib/write-guard.ts.
    if (wroteNothing(data)) {
      save.end(false);
      toast.error("ยังไม่ได้บันทึก", { description: await noRowsMessage() });
      return;
    }
    ackRow(id, partial); // what was WRITTEN - a note goes up trimmed
    save.end(true);
    notifyLive();
  }

  // A batch reorder write is N independent UPDATEs (Promise.all) — they can land
  // partially. When some but not all of them missed, the screen must not assert
  // either "pre-edit" or "post-edit" order (both are now guesses); re-read the
  // server so it matches whatever actually landed. Keeps any row that's still
  // local-only (not yet flushed from the offline outbox) visible even though the
  // refetch itself can't see it, and drops it from localOnlyIds once it can.
  async function reconcileFromServer(optimistic: SetlistItem[]) {
    const { data } = await supabase
      .from("setlist_items")
      .select("*")
      .eq("event_id", eventId)
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true }); // ties read the same as Live (lib/queries.ts)
    if (!data) return;
    const server = data as SetlistItem[];
    ackedRef.current = server;
    const serverIds = new Set(server.map((it) => it.id));
    serverIds.forEach((id) => localOnlyIds.current.delete(id));
    const stillLocal = optimistic.filter(
      (it) => localOnlyIds.current.has(it.id) && !serverIds.has(it.id)
    );
    setItems([...server, ...stillLocal].sort((a, b) => a.sort_order - b.sort_order));
    // Reached only when SOME of the batch's writes landed — the DB now holds a
    // new order. A running Live Mode needs to know regardless of who called us,
    // so broadcast here rather than trust every call site to remember it.
    notifyLive();
  }

  /** A batch write that came back with its row - it is on the server. */
  function landed(r: { error: unknown; data: unknown[] | null }): boolean {
    return !r.error && Array.isArray(r.data) && r.data.length > 0;
  }

  function update(id: string, partial: Partial<SetlistItem>) {
    setLocal(id, partial);
    persist(id, partial);
  }

  // Remember each item's duration right before "เวลาที่เหลือ" overwrote it, so the
  // user can undo and not lose a real song length (in-session; clears on reload).
  const [prevDuration, setPrevDuration] = useState<Record<string, number>>({});

  // Items whose folded "เล่นซ้อน / เผื่อเวลา" the user opened on a phone. An item
  // that already uses either is always shown open — a set value never hides.
  const [timingOpen, setTimingOpen] = useState<Set<string>>(new Set());
  const hasTiming = (it: SetlistItem) =>
    (it.buffer_before_seconds ?? 0) !== 0 || (it.buffer_after_seconds ?? 0) !== 0;
  const showTiming = (it: SetlistItem) => hasTiming(it) || timingOpen.has(it.id);
  // Once shown open, an item STAYS open: clearing a buffer to 0 (or typing 0 into
  // the overlap) used to fold both fields away mid-edit, under the thumb.
  useEffect(() => {
    const opened = items.filter(hasTiming).map((i) => i.id);
    if (opened.some((id) => !timingOpen.has(id))) {
      setTimingOpen((prev) => new Set([...prev, ...opened]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Set this item's duration to all the time left until Hard Out (e.g. final MC).
  // startSec is this row's clock-of-day start (already includes its buffer_before).
  function fillRemaining(itemId: string, startSec: number, bufferAfter: number) {
    // timing's, not the raw one: it is null without a show start too (see timing)
    if (timing.hardOutSec == null) return;
    // timing.hardOutSec is hardOutSec folded past midnight when the show starts
    // before it (23:00 show, 00:30 hard out) — startSec is already a folded
    // clock-of-day value from computeSetlistTimes, so subtracting the raw
    // (unfolded) hardOutSec here would go negative and refuse a valid fill.
    const dur = Math.round(timing.hardOutSec! - Math.max(0, bufferAfter || 0) - startSec);
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

  /** Offline insert fallback: mint the full row locally (stable client uuid). */
  function mintLocalItem(
    sort: number,
    extra: Partial<SetlistItem> & { kind: SetlistKind }
  ): SetlistItem {
    return {
      id: newLocalRowId(),
      tenant_id: tenantId,
      event_id: eventId,
      title: "",
      duration_seconds: 0,
      buffer_before_seconds: 0,
      buffer_after_seconds: 0,
      mic_slots: [],
      notes: null,
      sort_order: sort,
      song_id: null,
      audio_path: null,
      audio_name: null,
      loop_audio: false,
      ...extra,
    };
  }

  // The highest sort_order of this event's rows: the server's, read just before an
  // insert, or this screen's own copy when that is higher or the read fails (offline
  // the insert behind it fails too and is queued with the local number). This copy
  // alone is never re-seeded while its tab is open, so a laptop and a phone adding a
  // row (or "จากคลัง") at once numbered both new rows the same - Live Mode then plays
  // the two by uuid while each editor shows its own row last. run-order-builder's
  // lastSortOrder() is the same read.
  async function lastSortOrder(): Promise<number> {
    const local = items.length ? Math.max(...items.map((i) => i.sort_order)) : 0;
    try {
      const { data, error } = await supabase
        .from("setlist_items")
        .select("sort_order")
        .eq("event_id", eventId)
        .order("sort_order", { ascending: false })
        .limit(1);
      const server = !error
        ? Number((data?.[0] as { sort_order?: unknown } | undefined)?.sort_order)
        : NaN;
      return Number.isFinite(server) ? Math.max(local, server) : local;
    } catch {
      return local;
    }
  }

  /** Returns true when a row was actually added (inserted or queued offline). */
  async function insertItem(
    extra: Partial<SetlistItem> & { kind: SetlistKind }
  ): Promise<boolean> {
    // In-flight guard: a double-click would compute the same max(sort_order)+1
    // twice → two rows with equal sort_order the arrow buttons can't reorder.
    // The buttons are disabled while busy, but state lags the ref by a render —
    // never drop the click silently, tell the user to try again.
    if (insertingRef.current) {
      toast.info("กำลังเพิ่มรายการก่อนหน้า — รอสักครู่แล้วกดใหม่", {
        id: "setlist-inserting",
      });
      return false;
    }
    insertingRef.current = true;
    setInserting(true);
    try {
      // Joining a snapshot still queued (see queueBehindPending): numbered from this
      // screen's list, which is the whole list that snapshot will write.
      const queuedSort = items.length ? Math.max(...items.map((i) => i.sort_order)) + 1 : 1;
      const queuedRow = mintLocalItem(queuedSort, extra);
      if (await queueBehindPending([...items, queuedRow])) {
        localOnlyIds.current.add(queuedRow.id);
        setItems((prev) => [...prev, queuedRow]);
        return true;
      }
      const sort = (await lastSortOrder()) + 1;
      // Minted BEFORE the insert, and sent with it (2026-10-30, hunt 11): an insert whose
      // answer is lost can be read back by this id (insertLanded), and the offline queue
      // below holds the SAME row - a replay then finds it already there instead of adding
      // a second one.
      const local = mintLocalItem(sort, extra);
      const res = await supabase
        .from("setlist_items")
        .insert({
          id: local.id,
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
      const { error, status } = res;
      let data = res.data as SetlistItem | null;
      if (error || !data) {
        data = (await insertLanded<SetlistItem>(supabase, [local.id], error, status))?.[0] ?? null;
      }
      if (!data) {
        if (await queueOffline([...items, local], error?.message, status)) {
          localOnlyIds.current.add(local.id);
          setItems((prev) => [...prev, local]);
          return true;
        }
        toast.error("เพิ่มไม่สำเร็จ", { description: writeErrorText(error) });
        return false;
      }
      const row = data;
      ackedRef.current = [...ackedRef.current, row];
      setItems((prev) => [...prev, row]);
      notifyLive();
      return true;
    } finally {
      insertingRef.current = false;
      setInserting(false);
    }
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
    const added = await insertItem({
      kind: "song",
      title: song.title,
      duration_seconds: song.duration_seconds,
      song_id: song.id, // link → Live Mode plays the library song's audio
    });
    if (added) toast.success(`เพิ่ม "${song.title}" จากคลังแล้ว`);
  }

  // Swapping one song for another IN PLACE. Measured 2026-09-28 over Seishin's
  // last 18 shows: 60 songs came in, 52 of them mid-set — and the only way was
  // delete (+confirm) → "จากคลัง" (appended last) → ▲ once per row to climb back,
  // about ten taps a song. The row keeps its place, its mic formation and its
  // notes: on real song rows those are the band's standing mics and cues for the
  // SLOT ("เล่นต่อเนื่อง", "พูดชื่อเพลง"), not facts about the old song. It takes
  // the new song's title, length and audio link (song_id wins over any legacy
  // per-row audio — lib/audio-targets.ts).
  // The row being swapped, kept after the dialog closes so its heading does not
  // flash to "แถวที่ " during the close animation; `replaceOpen` is the dialog.
  const [replacing, setReplacing] = useState<SetlistItem | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  function replaceFromLibrary(song: Song) {
    const it = replacing;
    setReplaceOpen(false);
    if (!it) return;
    // The dialog was open while the show moved on — the row went on air.
    if (liveItemId === it.id) {
      toast.error("แถวนี้กำลังเล่นอยู่บนเวที — ยังเปลี่ยนเพลงไม่ได้");
      return;
    }
    update(it.id, {
      title: song.title,
      // A library song with no length yet keeps the row's: 0:00 would silently
      // pull every later start time forward and break the set's run time.
      duration_seconds: song.duration_seconds || it.duration_seconds,
      song_id: song.id,
    });
  }
  const songIdsInSet = useMemo(
    () => new Set(items.map((i) => i.song_id).filter((x): x is string => !!x)),
    [items]
  );
  const songsById = useMemo(() => new Map(songs.map((s) => [s.id, s])), [songs]);

  // Music for a row that is not a song - an MC's bed, an SE, an interlude's track (พี่
  // 2026-10-17: it took a song row turned into MC by hand). Live Mode plays any row linked
  // to a library song, so the link is all that is written. The row keeps its title and its
  // OWN length - the slot is the plan; the file fills it (Loop) or plays past it - and only
  // an empty 0:00 slot starts at the file's. An MC's first music loops, and Live Mode starts
  // it at the MC level (lib/live-levels.ts). A swap keeps the Loop the row already had.
  const [attaching, setAttaching] = useState<SetlistItem | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  function attachFromLibrary(song: Song) {
    const picked = attaching;
    setAttachOpen(false);
    if (!picked) return;
    if (liveItemId === picked.id) {
      toast.error("แถวนี้กำลังเล่นอยู่บนเวที — ยังเปลี่ยนเพลงไม่ได้");
      return;
    }
    // the row as it stands now: a length typed while the dialog was open counts
    const it = items.find((i) => i.id === picked.id) ?? picked;
    const patch: Partial<SetlistItem> = { song_id: song.id };
    if (!it.duration_seconds && song.duration_seconds) patch.duration_seconds = song.duration_seconds;
    if (it.kind === "mc" && !it.song_id) patch.loop_audio = true;
    update(it.id, patch);
  }
  function detachSong(it: SetlistItem) {
    if (liveItemId === it.id) {
      toast.error("แถวนี้กำลังเล่นอยู่บนเวที — ยังเปลี่ยนเพลงไม่ได้");
      return;
    }
    update(it.id, { song_id: null });
  }

  /** Clone a row (appended at the end — drag into place). The library song link and its
   *  Loop come along (a pointer, not a file: MC 1 and MC 2 often share one bed); a legacy
   *  per-row file does not. */
  async function duplicateItem(it: SetlistItem) {
    const added = await insertItem({
      kind: it.kind,
      title: it.title,
      song_id: it.song_id ?? null,
      loop_audio: !!it.loop_audio,
      duration_seconds: it.duration_seconds,
      buffer_before_seconds: it.buffer_before_seconds,
      buffer_after_seconds: it.buffer_after_seconds,
      mic_slots: it.mic_slots,
      notes: it.notes,
    });
    if (added) toast.success("ก๊อปรายการแล้ว — ลากไปจัดตำแหน่งได้");
  }

  async function removeItem(id: string) {
    const snapshot = items;
    const removed = snapshot.find((it) => it.id === id);
    const ok = await confirm({
      title: "ลบรายการนี้ออกจากเซ็ตลิสต์?",
      description: removed?.title
        ? `“${removed.title}” จะถูกลบออกจากเซ็ตลิสต์`
        : "รายการนี้จะถูกลบออกจากเซ็ตลิสต์",
    });
    if (!ok) return;
    // The sheet sat open while the show moved on: the row may be ON AIR now (Auto,
    // or the operator's NEXT, took it). Deleting it would pull the playing song from
    // under Live Mode, whose refetch then clamps onto the following row - the same
    // re-check เปลี่ยน and ใส่เพลง make after their dialog, read from the ref because
    // this handler's `liveItemId` is the one from before the sheet opened.
    if (liveItemIdRef.current === id) {
      toast.error("แถวนี้กำลังเล่นอยู่บนเวที — ยังลบไม่ได้");
      return;
    }
    const next = snapshot.filter((it) => it.id !== id);
    setItems((prev) => prev.filter((it) => it.id !== id));
    if (await queueBehindPending(next)) {
      deleteAudio(eventId, id).catch(() => {}); // local cache
      return;
    }
    const { data, error, status } = await supabase
      .from("setlist_items")
      .delete()
      .eq("id", id)
      .select("id");
    if (error) {
      if (await queueOffline(next, error.message, status)) {
        deleteAudio(eventId, id).catch(() => {}); // local cache
        // legacy per-item R2 audio can't be deleted offline; benign orphan at worst
        return;
      }
      toast.error("ลบไม่สำเร็จ", { description: writeErrorText(error) });
      setItems(snapshot);
      return;
    }
    // No error and no row = sent as anon after a failed token refresh — the row
    // (and its audio) is still there on the server. See lib/write-guard.ts.
    if (wroteNothing(data)) {
      toast.error("ยังไม่ได้ลบ", { description: await noRowsMessage() });
      setItems(snapshot);
      return;
    }
    ackedRef.current = ackedRef.current.filter((it) => it.id !== id);
    deleteAudio(eventId, id).catch(() => {}); // local cache
    // don't delete a library song's file when removing a linked row (library owns it)
    if (removed?.audio_path && !removed.song_id)
      removeEventAudio(removed.audio_path).catch(() => {}); // legacy ad-hoc only
    notifyLive();
  }

  /** Persist a full renumber: optimistic set, write every changed row, roll back on failure. */
  async function persistOrder(
    prev: SetlistItem[],
    renumbered: SetlistItem[],
    failMsg: string
  ) {
    setItems(renumbered);
    if (await queueBehindPending(renumbered)) return;
    const changed = renumbered.filter(
      (it) => prev.find((o) => o.id === it.id)?.sort_order !== it.sort_order
    );
    const results = await Promise.all(
      changed.map((it) =>
        supabase
          .from("setlist_items")
          .update({ sort_order: it.sort_order })
          .eq("id", it.id)
          .select("id")
      )
    );
    // Every write that came back with its row is on the server, whatever its
    // siblings did - so a snapshot queued for the rest is based on what is there.
    results.forEach((r, i) => {
      if (landed(r)) ackRow(changed[i].id, { sort_order: changed[i].sort_order });
    });
    const failed = results.find((r) => r.error);
    if (failed?.error) {
      if (await queueOffline(renumbered, failed.error.message, failed.status)) return;
      toast.error(failMsg, { description: failed.error.message });
      // Independent UPDATEs: some may have landed before one errored (a 503 on
      // venue wifi). Asserting `prev` would then show an order the server no longer
      // holds while Live plays the new one (ties by uuid) - re-read it instead, as
      // the 0-row twin below does.
      if (results.some(landed)) {
        await reconcileFromServer(renumbered);
        return;
      }
      setItems(prev);
      return;
    }
    // The results themselves settle whether a row is still local-only, so trust
    // them over the set: the outbox flush re-uses the client-minted id, so once
    // it lands the row IS on the server under that same id and nothing was
    // clearing the flag — every later reorder was then judged as "wrote nothing
    // real" and reported unsaved while it had in fact saved.
    results.forEach((r, i) => {
      if (!wroteNothing(r.data)) localOnlyIds.current.delete(changed[i].id);
    });
    // A 0-row result on a row that only exists in the offline outbox so far
    // (localOnlyIds) is expected, not a failure — skip those when judging the
    // batch. `changed` and `results` stay index-aligned (both come from the
    // same .map), so results[i] corresponds to changed[i].
    const attempted = changed.filter((it) => !localOnlyIds.current.has(it.id));
    const missed = results.filter(
      (r, i) => !localOnlyIds.current.has(changed[i].id) && wroteNothing(r.data)
    );
    if (!attempted.length) {
      // EVERY changed row is local-only — there was no real write to land or
      // miss (an UPDATE against a client-minted id that doesn't exist on the
      // server yet returns 0 rows with no error, same as `wroteNothing`, so it
      // never hit the offline queue either — queueOffline only triggers on an
      // actual error). The new order exists only in this tab's optimistic
      // state: on web these rows can't exist without a server counterpart, so
      // this is desktop-only; the queued insert behind them will still flush
      // with whatever order it was queued at, not this one. Say that plainly
      // instead of a success toast, and don't tell Live Mode to pull an order
      // the server never received.
      toast.error(failMsg, {
        description:
          "รายการที่ย้ายยังไม่มีอยู่จริงในเซิร์ฟเวอร์ (รอซิงค์จากคิวออฟไลน์) — ลำดับนี้ยังไม่ถูกบันทึก จัดลำดับอีกครั้งหลังซิงค์เสร็จ",
      });
      return;
    }
    if (missed.length === attempted.length) {
      // No error and no row on any real write = sent as anon after a failed
      // token refresh — the server order is unchanged, so asserting the
      // pre-edit order back is safe (nothing landed to disagree with).
      toast.error(failMsg, { description: await noRowsMessage() });
      setItems(prev);
      return;
    }
    if (missed.length) {
      // These are independent UPDATEs (Promise.all) — they can land partially.
      // Asserting `prev` here would put the screen on the pre-edit order while
      // some rows already committed to the new one — DB and screen would
      // disagree, with the screen looking authoritative. Keep the optimistic
      // order in view and reconcile with whatever the server actually holds.
      toast.error(failMsg, {
        description: `บางรายการไม่ได้บันทึก — ${await noRowsMessage()}`,
      });
      await reconcileFromServer(renumbered);
      return;
    }
    notifyLive();
  }

  async function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= items.length) return;
    const a = items[index];
    const b = items[target];
    if (hasRunOrderTie(items)) {
      // Duplicate sort_order ANYWHERE (e.g. rows added concurrently from two devices):
      // swapping equal values is a DB no-op that silently reverts on reload, and a
      // swap beside a tie leaves rows Live orders by uuid, not as shown here
      // (2026-10-27; the run-order builder's rule) — renumber the whole list with
      // the two rows exchanged instead.
      const next = [...items];
      next[index] = b;
      next[target] = a;
      await persistOrder(
        items,
        next.map((it, i) => ({ ...it, sort_order: i + 1 })),
        "สลับลำดับไม่สำเร็จ"
      );
      return;
    }
    const next = [...items];
    next[index] = { ...b, sort_order: a.sort_order };
    next[target] = { ...a, sort_order: b.sort_order };
    next.sort((x, y) => x.sort_order - y.sort_order);
    setItems(next);
    if (await queueBehindPending(next)) return;
    const results = await Promise.all([
      supabase
        .from("setlist_items")
        .update({ sort_order: b.sort_order })
        .eq("id", a.id)
        .select("id"),
      supabase
        .from("setlist_items")
        .update({ sort_order: a.sort_order })
        .eq("id", b.id)
        .select("id"),
    ]);
    const rowIds = [a.id, b.id];
    const newSorts = [b.sort_order, a.sort_order];
    // A write that came back with its row is on the server, even if its twin errored.
    results.forEach((r, i) => {
      if (landed(r)) ackRow(rowIds[i], { sort_order: newSorts[i] });
    });
    const failed = results.find((r) => r.error);
    if (failed?.error) {
      if (await queueOffline(next, failed.error.message, failed.status)) return;
      toast.error("สลับลำดับไม่สำเร็จ", { description: failed.error.message });
      // One write landed and the other errored (a 503 / timeout on venue wifi): the
      // DB holds a half-swap - both rows on ONE sort_order, which Live orders by
      // uuid. Putting the pre-swap order back would show what the server no longer
      // holds; re-read it, as the 0-row twin below does.
      if (results.some(landed)) {
        await reconcileFromServer(next);
        return;
      }
      setItems(items);
      return;
    }
    // A 0-row result on a row that only exists in the offline outbox so far
    // (localOnlyIds) is expected, not a failure — skip it when judging the pair.
    // ...but a row that DID write is on the server now, whatever the set says:
    // the flush re-uses the client-minted id, so the flag has to be cleared from
    // the evidence or every later swap is misjudged (see persistOrder).
    results.forEach((r, i) => {
      if (!wroteNothing(r.data)) localOnlyIds.current.delete(rowIds[i]);
    });
    const attempted = rowIds.filter((id) => !localOnlyIds.current.has(id));
    const missed = results.filter(
      (r, i) => !localOnlyIds.current.has(rowIds[i]) && wroteNothing(r.data)
    );
    if (!attempted.length) {
      // BOTH swapped rows are local-only — there was no real write to land or
      // miss (an UPDATE against a client-minted id that doesn't exist on the
      // server yet returns 0 rows with no error, same as `wroteNothing`, so it
      // never hit the offline queue either — queueOffline only triggers on an
      // actual error). The swap exists only in this tab's optimistic state: on
      // web these rows can't exist without a server counterpart, so this is
      // desktop-only; the queued insert behind them will still flush with
      // whatever order it was queued at, not this one. Say that plainly
      // instead of a success toast, and don't tell Live Mode to pull an order
      // the server never received.
      toast.error("สลับลำดับไม่สำเร็จ", {
        description:
          "รายการที่สลับยังไม่มีอยู่จริงในเซิร์ฟเวอร์ (รอซิงค์จากคิวออฟไลน์) — ลำดับนี้ยังไม่ถูกบันทึก จัดลำดับอีกครั้งหลังซิงค์เสร็จ",
      });
      return;
    }
    if (missed.length === attempted.length) {
      // No error and no row on either real write = sent as anon after a failed
      // token refresh — the server order is unchanged, so asserting the
      // pre-swap order back is safe (nothing landed to disagree with).
      toast.error("สลับลำดับไม่สำเร็จ", { description: await noRowsMessage() });
      setItems(items);
      return;
    }
    if (missed.length) {
      // These are two independent UPDATEs (Promise.all) — one can land while the
      // other misses. Asserting `items` here would put the screen back on the
      // pre-swap order while one row already committed to the new one — DB and
      // screen would disagree, with the screen looking authoritative. Keep the
      // optimistic order in view and reconcile with what the server actually holds.
      toast.error("สลับลำดับได้ไม่ครบ", {
        description: `บางรายการไม่ได้บันทึก — ${await noRowsMessage()}`,
      });
      await reconcileFromServer(next);
      return;
    }
    notifyLive();
  }

  /** Drag & drop reorder (desktop): move the dragged row to `target` index. */
  async function handleDrop(target: number) {
    const from = dragIndex.current;
    dragIndex.current = null;
    setDragOverIndex(null);
    if (from == null || from === target) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    await persistOrder(
      items,
      next.map((it, i) => ({ ...it, sort_order: i + 1 })),
      "เรียงลำดับไม่สำเร็จ"
    );
  }

  // The slot the set must fit: show start → hard out (folded past midnight by
  // computeSetlistTimes). Without both there is no slot, so no "/ 60:00" and no tick.
  const slotSec =
    hasClock && timing.hardOutSec != null ? timing.hardOutSec - showStartSec! : null;

  return (
    <div className="space-y-3">
      {/* RUN TIME (spec §G.3): the set's length, the slot it must fit, the set's
          shape as a strip (songs solid, the rest lighter, overflow hatched) with the
          hard out as a tick, then in-time or over in words. */}
      <section className="slab p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="eyebrow key text-muted-foreground">Run time</span>
          <span className="text-[12.5px] text-muted-foreground">
            <span className="num text-[15px] text-foreground">{items.length}</span> รายการ
            {hasClock && (
              <>
                {" · "}
                <span className="num text-[15px] text-foreground">
                  {formatClockOfDay(showStartSec!)}–{formatClockOfDay(timing.endSec)}
                </span>
              </>
            )}
          </span>
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="num text-[58px] font-extrabold leading-[.9]">
            {formatDuration(timing.totalSeconds)}
          </span>
          {slotSec != null && (
            <span className="num text-[24px] text-faint">/ {formatDuration(slotSec)}</span>
          )}
        </div>
        {items.length > 0 && (
          <RunMeter
            className="mt-3"
            blocks={items.map((it, i) => ({
              kind: it.kind,
              seconds: Math.max(
                0,
                (timing.rows[i]?.slotEndSec ?? 0) - (timing.rows[i]?.slotStartSec ?? 0)
              ),
            }))}
            slotSeconds={slotSec}
            hardOutSeconds={slotSec}
          />
        )}
        {slotSec != null && items.length > 0 && (
          <div className="mt-1.5 flex justify-between text-[11px] text-faint">
            <span className="num text-[13px]">{formatClockOfDay(showStartSec!)}</span>
            <span>
              Hard Out <span className="num text-[13px]">{formatClockOfDay(timing.hardOutSec!)}</span>
            </span>
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
        {/* timing's hard out: none without a show start - no in-time / over claim then */}
        {timing.hardOutSec != null && (
          <>
            {/* Over is the band-independent alarm, never --destructive: a red
                band's skin moves that token off red (lib/skin.ts). */}
            {timing.isOver ? (
              <span className="chip chip-alarm">
                <OctagonAlert aria-hidden /> เกิน Hard Out +{formatDuration(timing.overBy)}
              </span>
            ) : items.length > 0 ? (
              <span className="flex items-center gap-1.5 text-[13px] text-success-ink">
                <Check aria-hidden className="h-[15px] w-[15px]" /> อยู่ในเวลา · เหลือ{" "}
                <span className="num text-[16px]">
                  {formatDuration(Math.max(0, timing.hardOutSec! - timing.endSec))}
                </span>{" "}
                ก่อน Hard Out
              </span>
            ) : null /* an empty set is not "in time" — nothing to be on time with */}
            {/* The same "เวลาที่เหลือ" the last row has, put where the mismatch is
                SHOWN. Measured 2026-09-28: in 10 of Seishin Kakumei's 25 shows the
                closing row (ถ่ายรูป / MC) was filled to the second — so the button
                is wanted — and in 12 the set ended 18–34 s short or over, almost
                always a show copied from one that fitted and then had a song
                swapped. The only button was down on the last row, often below the
                fold of a long set, while the number saying "doesn't fit" is up here. */}
            {(() => {
              const lastIdx = items.length - 1;
              const last = items[lastIdx];
              const lastRow = timing.rows[lastIdx];
              const off = Math.round(timing.hardOutSec! - timing.endSec) !== 0;
              // Not without a show start (the times count from 00:00 then, and the
              // "fill" would make the last row ~19 hours long), and not when the set
              // ends on a SONG — that length is the track's real length; stretching
              // it to fill slack would put Live Mode's countdown out of step with
              // the audio. The closing MC / photo row is what this is for.
              if (
                !last ||
                !lastRow ||
                !off ||
                !editable ||
                !hasClock ||
                last.kind === "song" ||
                liveItemId === last.id
              )
                return null;
              return (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    fillRemaining(last.id, lastRow.startSec, last.buffer_after_seconds)
                  }
                  title="ตั้งความยาวแถวสุดท้าย = เวลาที่เหลือจนถึง Hard Out"
                  className="max-w-full gap-1 text-[13px]"
                >
                  <AlarmClock aria-hidden className="h-4 w-4 shrink-0" />
                  <span className="truncate">
                    ให้ “{last.title?.trim() || "แถวสุดท้าย"}” เติมให้พอดี
                  </span>
                </Button>
              );
            })()}
          </>
        )}
          {/* The receipt. Sits with the numbers the operator is already scanning,
              rather than floating over the list — a standing statement about the
              whole builder, not a per-row flourish. Editors only: a member saves
              nothing here. */}
          {editable &&
            (save.state === "idle" ? (
              <span className="ml-auto text-[12.5px] text-muted-foreground">บันทึกอัตโนมัติ</span>
            ) : (
              <SaveStatus state={save.state} className="ml-auto" />
            ))}
        </div>
      </section>

      {items.length === 0 && (
        <p className="rounded-[2px] border border-dashed py-10 text-center text-sm text-muted-foreground">
          ยังไม่มีรายการในเซ็ตลิสต์
        </p>
      )}

      {/* Items: a member reads a compact cue list; an editor gets the full rows */}
      <div className={editable ? "space-y-2" : "stack"}>
        {items.map((it, idx) => {
          const t = timing.rows[idx];
          // This row is on air in a running Live Mode → lock its edits (can't change
          // what's playing). Other rows stay editable and sync to Live Mode live.
          const isLive = liveItemId === it.id;
          const rowEditable = editable && !isLive;
          // A row that ends past the hard out: the alarm rail (band-independent —
          // never --destructive, which a red band's skin moves off red) and the
          // octagon, so it is never colour alone. The on-air rail wins over it.
          const rowTone = cn(
            t?.overHardOut && "bg-alarm/[.06] shadow-[inset_3px_0_0_hsl(var(--alarm)),inset_0_0_0_1px_hsl(var(--border))]",
            isLive && "shadow-[inset_4px_0_0_hsl(var(--primary)),inset_0_0_0_1px_hsl(var(--border))]"
          );
          const overMark = t?.overHardOut ? (
            <span className="inline-flex items-center gap-0.5 font-semibold text-foreground">
              <OctagonAlert aria-hidden className="h-[13px] w-[13px]" />
              เกิน Hard Out
            </span>
          ) : null;

          // Members read the set; they do not edit it. A compact cue row (spec
          // §G.3): index · kind tile · title over start / mics / note · length.
          // Every field guarded — the desktop shows cached rows.
          if (!editable) {
            const slots = it.mic_slots ?? [];
            return (
              <div key={it.id} className={cn("slab flex min-h-[60px] items-center gap-3 px-3 py-2", rowTone)}>
                <span className="num w-4 flex-none text-right text-[14px] text-faint">{idx + 1}</span>
                <KindTile kind={it.kind} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[15px] font-medium leading-tight">
                    {isLive && (
                      <>
                        <i aria-hidden className="onair-dot" />
                        <span className="sr-only">กำลังเล่นอยู่บนเวที</span>
                      </>
                    )}
                    <span className="truncate">{it.title || "—"}</span>
                  </div>
                  <div className="mt-[3px] flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
                    {hasClock && t && (
                      <span className="num flex-none text-[15px] text-foreground/85">
                        {formatClockOfDay(t.startSec)}
                      </span>
                    )}
                    {overMark}
                    {slots.length > 0 && (
                      <span className="flex min-w-0 items-center gap-1">
                        <Mic aria-hidden className="h-3 w-3 flex-none" />
                        <span className="truncate">
                          {slots.map((s) => (s.member ? `${s.mic}·${s.member}` : s.mic)).join("  ")}
                        </span>
                      </span>
                    )}
                    {it.notes && <span className="truncate">· {it.notes}</span>}
                  </div>
                </div>
                <span className="num flex-none text-[19px]">{formatDuration(it.duration_seconds ?? 0)}</span>
              </div>
            );
          }

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
              data-setlist-row={it.id}
              onDragLeave={
                editable
                  ? () => setDragOverIndex((v) => (v === idx ? null : v))
                  : undefined
              }
              className={cn(
                "slab p-3",
                rowTone,
                dragOverIndex === idx && "shadow-[inset_0_0_0_2px_hsl(var(--primary))]"
              )}
            >
              {isLive && (
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-primary-ink">
                  <i aria-hidden className="onair-dot" />
                  กำลังเล่นอยู่บนเวที — ล็อกแก้ไขชั่วคราว
                </div>
              )}
              {/* flex-wrap, because an EDITOR's row carries ~320px of controls that
                  cannot shrink (grip, index, kind select, four icon buttons) inside
                  a 332px content box on a 390px phone. The song title is the only
                  flexible child, so it absorbed the whole overshoot and collapsed to
                  a ~26px sliver — padding and border, no readable text. Wrapping puts
                  the title on its own line below sm and restores the single-line
                  desktop layout at sm: (see the Input's basis-full sm:basis-0). */}
              <div className="flex flex-wrap items-center gap-2">
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
                    // Only where there is a mouse: HTML5 drag never starts from a
                    // touch, and on a phone this was a 16×16 target that did nothing
                    // (▲ ▼ on each row are the touch way to reorder).
                    className="hidden h-11 w-6 shrink-0 cursor-grab place-items-center text-muted-foreground hover:text-foreground active:cursor-grabbing [@media(hover:hover)]:grid"
                    aria-label="ลากเพื่อย้ายลำดับ"
                  >
                    <GripVertical className="h-4 w-4" />
                  </button>
                )}
                <span className="num w-4 shrink-0 text-right text-[14px] text-faint">
                  {idx + 1}
                </span>
                {/* 92px with a tighter trigger: the field's own px-3.5 + gap-2 + chevron
                    left 36px for the label in 88px, so a phone's 16px "SONG" (41px)
                    read "SONC", and "GUEST" (47px; 41px at sm's 14px) clipped on
                    every screen. This leaves
                    52px, and the row still fits one line at 390 with the mouse-only
                    grip shown (grip 24 + index 16 + 4×44 buttons + gaps + 92 = 332 of
                    334). Measured in Chrome; setlist-builder.rows.test.tsx holds it. */}
                <div className="w-[92px] shrink-0">
                  <Select
                    value={it.kind}
                    disabled={!rowEditable}
                    onValueChange={(v) => update(it.id, { kind: v as SetlistKind })}
                  >
                    <SelectTrigger className="gap-1 pl-3 pr-2" aria-label="ประเภทรายการ">
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
                {/* grow + basis rather than flex-1: Tailwind emits flex-basis
                    before flex, so flex-1 (basis:0%) would win over basis-full and
                    the row would never wrap. order-2 below sm: the title takes the
                    second line and the row buttons ride up beside the kind select,
                    where 212px sat empty — measured at 390px, three lines a row
                    became two. */}
                <div className="order-2 flex min-w-0 grow basis-full items-center gap-2 sm:order-none sm:basis-0">
                  <Input
                    className="min-w-0 flex-1"
                    value={it.title}
                    disabled={!rowEditable}
                    aria-label="ชื่อเพลง / หัวข้อ"
                    placeholder="ชื่อเพลง / หัวข้อ"
                    onChange={(e) => setLocal(it.id, { title: e.target.value })}
                    onBlur={(e) => persist(it.id, { title: e.target.value })}
                  />
                  {rowEditable && it.kind === "song" && songs.length > 0 && (
                    <Button
                      type="button"
                      variant="secondary"
                      className="shrink-0 px-2.5"
                      title="เปลี่ยนเป็นเพลงอื่นจากคลัง — ตำแหน่ง ไมค์ และโน้ตคงเดิม"
                      data-replace-row={it.id}
                      onClick={() => {
                        setReplacing(it);
                        setReplaceOpen(true);
                      }}
                    >
                      <ListMusic className="h-4 w-4" /> เปลี่ยน
                    </Button>
                  )}
                  {rowEditable && it.kind !== "song" && !it.song_id && songs.length > 0 && (
                    <Button
                      type="button"
                      variant="secondary"
                      className="shrink-0 px-2.5"
                      title="ใส่เพลง / ดนตรีประกอบจากคลัง — ชื่อและความยาวของแถวคงเดิม"
                      data-attach-row={it.id}
                      onClick={() => {
                        setAttaching(it);
                        setAttachOpen(true);
                      }}
                    >
                      <ListMusic className="h-4 w-4" /> ใส่เพลง
                    </Button>
                  )}
                </div>
                {rowEditable && (
                  <div className="order-1 ml-auto flex shrink-0 sm:order-none sm:ml-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => move(idx, -1)}
                      disabled={idx === 0}
                      aria-label="เลื่อนขึ้น"
                    >
                      <ChevronUp className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => move(idx, 1)}
                      disabled={idx === items.length - 1}
                      aria-label="เลื่อนลง"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="ก๊อปรายการนี้"
                      aria-label="ก๊อปรายการนี้"
                      disabled={inserting}
                      onClick={() => duplicateItem(it)}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive"
                      aria-label="ลบรายการนี้"
                      onClick={() => removeItem(it.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>

              {/* The music of a row that is not a song: what is linked, its Loop, swap, เอาออก. */}
              {it.kind !== "song" && it.song_id && (
                <div
                  data-testid={`row-music-${it.id}`}
                  className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-8 text-[13px] text-muted-foreground"
                >
                  <Music2 aria-hidden className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate text-foreground/85">
                    {songsById.get(it.song_id)?.title ?? "เพลงจากคลัง"}
                  </span>
                  {songsById.get(it.song_id)?.duration_seconds ? (
                    <span className="num shrink-0">{formatDuration(songsById.get(it.song_id)!.duration_seconds)}</span>
                  ) : null}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!!it.loop_audio}
                    disabled={!rowEditable}
                    onClick={() => update(it.id, { loop_audio: !it.loop_audio })}
                    title={
                      it.loop_audio
                        ? "Loop เปิด — เพลงวนจนครบเวลาของแถวแล้วเฟดจบเอง (แตะเพื่อปิด)"
                        : "Loop ปิด — เพลงเล่นรอบเดียว (แตะเพื่อให้วนจนครบเวลาของแถว)"
                    }
                    className={cn(
                      "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-[2px] px-2.5 shadow-[inset_0_0_0_1px_hsl(var(--border))] disabled:opacity-50",
                      it.loop_audio ? "font-semibold text-primary-ink" : "text-muted-foreground"
                    )}
                  >
                    <Repeat aria-hidden className="h-3.5 w-3.5" />
                    Loop
                  </button>
                  {rowEditable && songs.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="shrink-0 px-2.5 text-[13px]"
                      data-attach-swap={it.id}
                      onClick={() => {
                        setAttaching(it);
                        setAttachOpen(true);
                      }}
                    >
                      <ListMusic className="h-4 w-4" /> เปลี่ยนเพลง
                    </Button>
                  )}
                  {rowEditable && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="เอาเพลงออก"
                      title="เอาเพลงออกจากแถวนี้ (เพลงในคลังไม่หาย)"
                      onClick={() => detachSong(it)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              )}

              {/* Timing line */}
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-0.5 pl-8 text-[12.5px] text-muted-foreground">
                {overMark}
                {hasClock && (
                  <span>
                    เริ่ม <b className="num text-[15px] text-foreground/85">{formatClockOfDay(t.startSec)}</b> · จบ{" "}
                    <b className="num text-[15px] text-foreground/85">{formatClockOfDay(t.endSec)}</b>
                  </span>
                )}
                <span>
                  ความยาว <b className="num text-[15px] text-foreground/85">{formatDuration(it.duration_seconds ?? 0)}</b>
                </span>
                <span>
                  สะสม <b className="num text-[15px] text-foreground/85">{formatDuration(t?.accumulatedSec ?? 0)}</b>
                </span>
              </div>

              {/* Editable fields. On a phone these stacked one per line, ~640px an
                  item. Measured 2026-09-28 over 231 real rows: mics set on 26%, notes
                  on 23%, but "เล่นซ้อน" on 3% and "เผื่อเวลาหลัง" on 2%. So below sm
                  length and mics share a line, and the two timing tweaks fold behind
                  one button until a row uses them. From sm up nothing moves. */}
              <div className="mt-2 grid grid-cols-2 gap-2 pl-8 sm:grid-cols-12">
                <div className="order-1 space-y-1 sm:order-none sm:col-span-2">
                  <Label
                    htmlFor={`sl-${it.id}-dur`}
                    className="text-[13px] font-medium text-muted-foreground"
                  >
                    ความยาว (m:ss)
                  </Label>
                  <DurationField
                    id={`sl-${it.id}-dur`}
                    seconds={it.duration_seconds}
                    disabled={!rowEditable}
                    onCommit={(s) => update(it.id, { duration_seconds: s })}
                  />
                  {/* "เวลาที่เหลือ" only on the LAST item — it fills to Hard Out, which
                      only makes sense for the closing row (e.g. final MC). */}
                  {rowEditable &&
                    hardOutSec != null &&
                    hasClock && // no show start = times from 00:00 = a nonsense fill
                    t &&
                    idx === items.length - 1 && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() =>
                          fillRemaining(it.id, t.startSec, it.buffer_after_seconds)
                        }
                        title="ตั้งความยาว = เวลาที่เหลือจนถึง Hard Out (เช่น MC ปิดท้าย)"
                        className="w-full gap-1 text-[13px]"
                      >
                        <AlarmClock aria-hidden className="h-4 w-4" /> เวลาที่เหลือ
                      </Button>
                    )}
                  {/* undo — restore the duration from before "เวลาที่เหลือ" was pressed */}
                  {rowEditable && prevDuration[it.id] != null && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => restoreDuration(it.id)}
                      title="คืนความยาวก่อนกด 'เวลาที่เหลือ'"
                      className="w-full gap-1 text-[13px] text-muted-foreground"
                    >
                      <RotateCcw aria-hidden className="h-4 w-4" /> คืนค่าเดิม{" "}
                      <span className="num">{formatDuration(prevDuration[it.id])}</span>
                    </Button>
                  )}
                </div>
                {idx > 0 && !showTiming(it) && (
                  <button
                    type="button"
                    onClick={() => setTimingOpen((prev) => new Set(prev).add(it.id))}
                    className="order-3 col-span-2 justify-self-start min-h-11 rounded-[2px] px-2 text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline sm:hidden"
                  >
                    + {TIMING_LABEL} (ซ้อน / รอ)
                  </button>
                )}
                {/* The first item has no item before it to overlap or wait for: no
                    field at all, so nothing can be set there by mistake (พี่ 2026-10-19). */}
                {idx > 0 && (
                <div className={`order-4 space-y-1 sm:order-none sm:col-span-3 ${showTiming(it) ? "" : "hidden sm:block"}`}>
                  {/* CQ-42: a label that wraps drops its input below the row's other
                      fields. "เข้าหลังเพลงก่อนหน้า (วิ)" (พี่ 2026-10-19: one wording with
                      the practice room) needs ~150px, so this cell is 3 of 12 (sm: ~160px)
                      and the label never wraps; what the number DOES is the line under
                      the field, in words, for the value typed. */}
                  <Label
                    htmlFor={`sl-${it.id}-overlap`}
                    className="whitespace-nowrap text-[13px] font-medium text-muted-foreground"
                  >
                    {TIMING_LABEL} (วิ)
                  </Label>
                  {/* type="number" made this unreachable on iOS, whose numeric keypad
                      has no minus key: an iPad user could only type positives, which
                      Math.min(0, …) silently flattened to 0 — the overlap looked
                      accepted and simply never happened. See TimingInput. */}
                  <TimingInput
                    id={`sl-${it.id}-overlap`}
                    title="ติดลบ = เล่นซ้อนเพลงก่อนหน้า (เช่น -5) · บวก = รอหลังเพลงก่อนหน้าจบ (เช่น 3) · 0 = เริ่มทันทีที่เพลงก่อนหน้าจบ"
                    seconds={it.buffer_before_seconds}
                    disabled={!rowEditable}
                    onChange={(s) => setLocal(it.id, { buffer_before_seconds: s })}
                    onCommit={(s) => persist(it.id, { buffer_before_seconds: s })}
                  />
                  <p
                    data-testid="timing-meaning"
                    className="text-[12px] leading-snug text-muted-foreground"
                  >
                    {timingMeaning(it.buffer_before_seconds)}
                  </p>
                </div>
                )}
                <div className={`order-2 space-y-1 sm:order-none ${idx > 0 ? "sm:col-span-7" : "sm:col-span-10"}`}>
                  <Label className="text-[13px] font-medium text-muted-foreground">ไมค์ + สมาชิก</Label>
                  <MicSlotsDialog
                    item={it}
                    eventId={eventId}
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
                    aria-label="โน้ต"
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
          <Button
            type="button"
            variant="default"
            disabled={inserting}
            onClick={() => addItem("song")}
          >
            <Plus className="h-4 w-4" /> เพลง
          </Button>
          <LibraryPickerDialog
            songs={songs}
            onPick={addFromLibrary}
            disabled={inserting}
            inSet={songIdsInSet}
          />
          <LibraryPickerDialog
            songs={songs}
            onPick={attachFromLibrary}
            inSet={songIdsInSet}
            open={attachOpen}
            onOpenChange={setAttachOpen}
            returnFocusTo={() =>
              attaching
                ? document.querySelector<HTMLElement>(
                    `[data-attach-row="${attaching.id}"], [data-attach-swap="${attaching.id}"]`
                  )
                : null
            }
            heading={`ใส่เพลงแถวที่ ${
              attaching ? items.findIndex((i) => i.id === attaching.id) + 1 : ""
            }`}
            hint={`ใส่ใน “${clip(attaching?.title?.trim() || "แถวนี้", 40)}” — ชื่อและความยาวของแถวคงเดิม${
              attaching?.kind === "mc" ? " · MC เล่นวน (Loop) และเริ่มที่ความดังระดับ MC" : ""
            }`}
          />
          <LibraryPickerDialog
            songs={songs}
            onPick={replaceFromLibrary}
            inSet={songIdsInSet}
            open={replaceOpen}
            onOpenChange={setReplaceOpen}
            returnFocusTo={() =>
              replacing
                ? document.querySelector<HTMLElement>(`[data-replace-row="${replacing.id}"]`)
                : null
            }
            heading={`เปลี่ยนเพลงแถวที่ ${
              replacing ? items.findIndex((i) => i.id === replacing.id) + 1 : ""
            }`}
            hint={`แทน “${clip(replacing?.title?.trim() || "เพลงนี้", 40)}” — อยู่ตำแหน่งเดิม ไมค์กับโน้ตคงไว้`}
          />
          {(
            [
              ["mc", "MC"],
              ["se", "SE"],
              ["instrument", "Instrument"],
              ["interlude", "Interlude"],
              ["guest", "Guest"],
            ] as const
          ).map(([kind, label]) => (
            <Button
              key={kind}
              type="button"
              variant="secondary"
              disabled={inserting}
              onClick={() => addItem(kind)}
            >
              <Plus aria-hidden className="h-4 w-4" /> <span className="en">{label}</span>
            </Button>
          ))}
          <span className="mx-1 self-center text-muted-foreground/40">|</span>
          <SetlistVersions
            eventId={eventId}
            tenantId={tenantId}
            items={items}
            onRestore={restoreSnapshot}
          />
        </div>
      )}
    </div>
  );
}
