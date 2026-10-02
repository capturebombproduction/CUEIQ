"use client";

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, ChevronUp, ChevronDown, Mic2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { newLocalRowId } from "@/lib/mgmt-outbox";
import { OFFLINE_QUEUED_MESSAGE, tryQueueChildList } from "@/lib/mgmt-write";
import { noRowsMessage, wroteNothing } from "@/lib/write-guard";
import { SaveStatus, useSaveSignal } from "@/components/event/save-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MicTile } from "@/components/event/mic-grid";
import { lineupStatus, memberLabel } from "@/lib/lineup";
import type { Member, MicAssignment, SetlistItem } from "@/lib/types";

/** One mic tile as the Mic Map draws it for a member to read (spec §G.3). */
const MIC_TILE_CLS = "py-2 [&_.num]:text-[28px] [&_.truncate]:text-[14px]";

/**
 * The mics the band actually uses when nobody has set any for THIS show: each
 * performing member's own standing `mic_number`. Zero per-event rows is the normal
 * case (40 of 41 production events, and the real 2026-10-03 show), and the Summary,
 * the Lineup, the readiness gate and the Excel sheet all already count the members'
 * numbers — this tab alone read "no mics". Same rule, same order and same labels as
 * lib/export-excel.ts micBaseRows([], performingMembers(…)); re-stated here rather
 * than imported because export-excel pulls the whole xlsx library, which this tab's
 * chunk must not carry. mic-map-editor.test.tsx pins the two together.
 */
function standingMics(
  members: Member[],
  lineup: string[]
): { num: number; name: string; labels: string[]; color: string | null }[] {
  const byMic = new Map<number, Member[]>();
  for (const m of lineupStatus(members, lineup).present) {
    if (m.mic_number == null) continue;
    const arr = byMic.get(m.mic_number) ?? [];
    arr.push(m);
    byMic.set(m.mic_number, arr);
  }
  return Array.from(byMic.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([num, holders]) => ({
      num,
      name: holders.map(memberLabel).join(", "),
      // one label per holder, in rotation order: what the first add seeds the show's own
      // map with (a shared mic is that many rows on one number, as the editor stores it)
      labels: holders.map(memberLabel),
      color: holders[0].color,
    }));
}

export function MicMapEditor({
  eventId,
  tenantId,
  editable,
  initialMics,
  members,
  lineup = [],
  setlist,
  eventName,
}: {
  eventId: string;
  tenantId: string;
  editable: boolean;
  initialMics: MicAssignment[];
  members: Member[];
  /** member ids performing at THIS event; empty = nobody picked = the whole band. */
  lineup?: string[];
  setlist: SetlistItem[];
  eventName?: string;
}) {
  const supabase = createClient();
  const confirm = useConfirm();
  const save = useSaveSignal();
  const [mics, setMics] = useState<MicAssignment[]>(initialMics);
  // In-flight guard for addMic/addHolder: a double-tap on the iPads the bands
  // actually use would compute the same max(...)+1 twice → two rows with an
  // identical mic_number/order_index, which then makes ▲▼ reorder a silent
  // DB no-op that reverts on reload. Never drop the second tap silently.
  const insertingRef = useRef(false);
  const [inserting, setInserting] = useState(false);

  // Group holders by mic number (rotation order within each).
  const groups = useMemo(() => {
    const map = new Map<number, MicAssignment[]>();
    for (const m of mics) {
      const arr = map.get(m.mic_number) ?? [];
      arr.push(m);
      map.set(m.mic_number, arr);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([num, holders]) => ({
        num,
        holders: holders.sort((a, b) => a.order_index - b.order_index),
      }));
  }, [mics]);

  // Only consulted while this show has no mics of its own; the moment an editor
  // adds one, the show's own map takes over (as it does on the Excel sheet) — which
  // is why that first add seeds the map from these (seedFromStanding below).
  const standing = groups.length === 0 ? standingMics(members, lineup) : [];

  // ⭐#1 step 5: a write that failed on a DEAD NETWORK queues the whole post-edit
  // mic map as one offline snapshot and returns true — keep the optimistic state.
  // Web (no sink) / real rejections return false → original handling. `mics` in
  // this render's closure is the pre-edit list = the online-wins guard's base.
  async function queueOffline(
    next: MicAssignment[],
    errorMessage: string | null | undefined
  ): Promise<boolean> {
    const queued = await tryQueueChildList({
      kind: "mic.upsert",
      eventId,
      tenantId,
      eventName,
      rows: next,
      baseRows: mics,
      errorMessage: errorMessage ?? null,
    });
    if (queued) toast.success(OFFLINE_QUEUED_MESSAGE, { id: "mgmt-offline-queued" });
    return queued;
  }

  // Reports into the same signal the setlist and schedule editors use — so the
  // ผังไมค์ tab gets the บันทึกแล้ว receipt it never had, and so the leave-the-page
  // warning (lib/dirty-guard.ts) can see a mic name that failed to save. Before
  // this, a failed holder_name was a toast and nothing else.
  async function persist(id: string, partial: Partial<MicAssignment>) {
    save.begin();
    try {
      const { data, error } = await supabase
        .from("mic_assignments")
        .update(partial)
        .eq("id", id)
        .select("id");
      if (error) {
        const next = mics.map((m) => (m.id === id ? { ...m, ...partial } : m));
        // Queued offline IS saved — it is on disk and it will flush.
        if (await queueOffline(next, error.message)) {
          save.end(true);
          return;
        }
        save.end(false);
        toast.error("บันทึกไม่สำเร็จ", { description: error.message });
        return;
      }
      // No error and no row = the write reached the server and changed nothing (sent
      // anon after a failed token refresh, or the row is gone). See lib/write-guard.ts.
      if (wroteNothing(data)) {
        save.end(false);
        toast.error("ยังไม่ได้บันทึก", { description: await noRowsMessage() });
        return;
      }
      save.end(true);
    } catch (e) {
      // supabase-js reports most failures in `error`, but a fetch that throws
      // (offline mid-flight, an aborted request) would otherwise leave this write
      // counted as in-flight forever: the badge stuck on กำลังบันทึก… and every
      // later exit warning about it.
      save.end(false);
      toast.error("บันทึกไม่สำเร็จ", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }

  /** Offline insert fallback: mint the row locally (stable client uuid). */
  function mintLocalMic(micNumber: number, holderName: string, orderIndex: number): MicAssignment {
    return {
      id: newLocalRowId(),
      tenant_id: tenantId,
      event_id: eventId,
      mic_number: micNumber,
      holder_name: holderName,
      order_index: orderIndex,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * The first เพิ่มไมค์ on a show whose tab is showing the members' standing mics
   * (no per-event rows). Per-event rows win on every surface the moment one exists —
   * Summary, Lineup, the readiness gate, the Excel sheet, this tab — so inserting only
   * the new empty mic would silently swap the band's mics for one blank one. Seed the
   * show's own map with what was on screen (one row per standing mic, a shared mic as
   * one row per holder in rotation order), then the new mic after them.
   *
   * ONE insert, so it is all-or-nothing: a failure leaves the tab exactly as it was,
   * still showing the standing mics. The write asks for its rows back and a reply with
   * none is "ยังไม่ได้บันทึก", never a success (lib/write-guard.ts).
   */
  async function seedFromStanding() {
    const nextNum = Math.max(...standing.map((s) => s.num)) + 1;
    const wanted = [
      ...standing.flatMap((s) =>
        s.labels.map((label, i) => ({ mic_number: s.num, holder_name: label, order_index: i + 1 }))
      ),
      { mic_number: nextNum, holder_name: "", order_index: 1 },
    ];
    const { data, error } = await supabase
      .from("mic_assignments")
      .insert(wanted.map((r) => ({ tenant_id: tenantId, event_id: eventId, ...r })))
      .select("*");
    if (error || !data) {
      const locals = wanted.map((r) => mintLocalMic(r.mic_number, r.holder_name, r.order_index));
      if (await queueOffline([...mics, ...locals], error?.message)) {
        setMics((prev) => [...prev, ...locals]);
        return;
      }
      toast.error("เพิ่มไมค์ไม่สำเร็จ", { description: error?.message });
      return;
    }
    if (wroteNothing(data)) {
      toast.error("ยังไม่ได้บันทึก", { description: await noRowsMessage() });
      return;
    }
    setMics((prev) => [...prev, ...(data as MicAssignment[])]);
  }

  async function addMic() {
    if (insertingRef.current) {
      toast.info("กำลังเพิ่มไมค์ก่อนหน้า — รอสักครู่แล้วกดใหม่", {
        id: "mic-inserting",
      });
      return;
    }
    insertingRef.current = true;
    setInserting(true);
    try {
      if (standing.length > 0) {
        await seedFromStanding();
        return;
      }
      const nextNum = groups.length ? Math.max(...groups.map((g) => g.num)) + 1 : 1;
      const { data, error } = await supabase
        .from("mic_assignments")
        .insert({
          tenant_id: tenantId,
          event_id: eventId,
          mic_number: nextNum,
          holder_name: "",
          order_index: 1,
        })
        .select("*")
        .single();
      if (error || !data) {
        const local = mintLocalMic(nextNum, "", 1);
        if (await queueOffline([...mics, local], error?.message)) {
          setMics((prev) => [...prev, local]);
          return;
        }
        toast.error("เพิ่มไมค์ไม่สำเร็จ", { description: error?.message });
        return;
      }
      setMics((prev) => [...prev, data as MicAssignment]);
    } finally {
      insertingRef.current = false;
      setInserting(false);
    }
  }

  async function addHolder(micNumber: number, name = "") {
    if (insertingRef.current) {
      toast.info("กำลังเพิ่มรายการก่อนหน้า — รอสักครู่แล้วกดใหม่", {
        id: "mic-inserting",
      });
      return;
    }
    insertingRef.current = true;
    setInserting(true);
    try {
      const inGroup = mics.filter((m) => m.mic_number === micNumber);
      const order = inGroup.length
        ? Math.max(...inGroup.map((m) => m.order_index)) + 1
        : 1;
      const { data, error } = await supabase
        .from("mic_assignments")
        .insert({
          tenant_id: tenantId,
          event_id: eventId,
          mic_number: micNumber,
          holder_name: name,
          order_index: order,
        })
        .select("*")
        .single();
      if (error || !data) {
        const local = mintLocalMic(micNumber, name, order);
        if (await queueOffline([...mics, local], error?.message)) {
          setMics((prev) => [...prev, local]);
          return;
        }
        toast.error("เพิ่มคนไม่สำเร็จ", { description: error?.message });
        return;
      }
      setMics((prev) => [...prev, data as MicAssignment]);
    } finally {
      insertingRef.current = false;
      setInserting(false);
    }
  }

  async function removeHolder(id: string) {
    const holder = mics.find((m) => m.id === id);
    const ok = await confirm({
      title: "เอาคนนี้ออกจากไมค์?",
      description: holder?.holder_name
        ? `“${holder.holder_name}” จะถูกเอาออกจากไมค์ #${holder.mic_number}`
        : "ผู้ถือไมค์คนนี้จะถูกเอาออก",
    });
    if (!ok) return;
    const snapshot = mics;
    setMics((prev) => prev.filter((m) => m.id !== id));
    const { error } = await supabase
      .from("mic_assignments")
      .delete()
      .eq("id", id);
    if (error) {
      if (await queueOffline(snapshot.filter((m) => m.id !== id), error.message)) return;
      toast.error("ลบไม่สำเร็จ", { description: error.message });
      setMics(snapshot);
    }
  }

  async function removeMic(micNumber: number) {
    const ok = await confirm({
      title: `ลบไมค์ #${micNumber}?`,
      description: "ผู้ถือไมค์ทุกคนในไมค์นี้จะถูกเอาออก",
    });
    if (!ok) return;
    const snapshot = mics;
    setMics((prev) => prev.filter((m) => m.mic_number !== micNumber));
    const { error } = await supabase
      .from("mic_assignments")
      .delete()
      .eq("event_id", eventId)
      .eq("mic_number", micNumber);
    if (error) {
      if (await queueOffline(snapshot.filter((m) => m.mic_number !== micNumber), error.message))
        return;
      toast.error("ลบไม่สำเร็จ", { description: error.message });
      setMics(snapshot);
    }
  }

  /** Returns true if applied, false if rejected (caller should revert the input). */
  function changeMicNumber(oldNum: number, newNum: number): boolean {
    if (newNum === oldNum) return true; // unchanged — keep as-is
    if (!Number.isFinite(newNum) || newNum < 1) return false;
    // don't silently merge into an existing mic group (would collide order_index)
    if (mics.some((m) => m.mic_number === newNum)) {
      toast.error(`ไมค์ ${newNum} มีอยู่แล้ว`, {
        description: "เลือกเบอร์อื่น หรือย้ายคนเข้ากลุ่มทีละคนแทน",
      });
      return false;
    }
    // rows this call moves — reverting by id keeps concurrent edits to OTHER
    // mics (which wrote fine) alive if this write later fails.
    const movedIds = new Set(
      mics.filter((m) => m.mic_number === oldNum).map((m) => m.id)
    );
    const next = mics.map((m) =>
      m.mic_number === oldNum ? { ...m, mic_number: newNum } : m
    );
    setMics(next);
    supabase
      .from("mic_assignments")
      .update({ mic_number: newNum })
      .eq("event_id", eventId)
      .eq("mic_number", oldNum)
      .select("id")
      .then(async ({ data, error }) => {
        if (error) {
          if (await queueOffline(next, error.message)) return;
          toast.error("เปลี่ยนเบอร์ไมค์ไม่สำเร็จ", { description: error.message });
          // real rejection — put only these rows back on oldNum (re-keys the input)
          setMics((prev) =>
            prev.map((m) =>
              movedIds.has(m.id) ? { ...m, mic_number: oldNum } : m
            )
          );
          return;
        }
        // No error but zero rows = sent anon after a failed token refresh — the
        // mic-number change never reached the DB. See lib/write-guard.ts.
        if (wroteNothing(data)) {
          toast.error("ยังไม่ได้บันทึก", { description: await noRowsMessage() });
          setMics((prev) =>
            prev.map((m) =>
              movedIds.has(m.id) ? { ...m, mic_number: oldNum } : m
            )
          );
        }
      });
    return true;
  }

  async function moveHolder(micNumber: number, index: number, dir: -1 | 1) {
    const group = groups.find((g) => g.num === micNumber);
    if (!group) return;
    const target = index + dir;
    if (target < 0 || target >= group.holders.length) return;
    const a = group.holders[index];
    const b = group.holders[target];
    if (a.order_index === b.order_index) {
      // Duplicate order_index (e.g. holders added concurrently from two devices):
      // swapping equal values is a DB no-op that silently reverts on reload —
      // renumber the whole group 1..n with the two holders exchanged instead.
      const reordered = [...group.holders];
      reordered[index] = b;
      reordered[target] = a;
      const renumbered = reordered.map((h, i) => ({ ...h, order_index: i + 1 }));
      const next = mics.map((m) => renumbered.find((h) => h.id === m.id) ?? m);
      setMics(next);
      const results = await Promise.all(
        renumbered.map((h) =>
          supabase
            .from("mic_assignments")
            .update({ order_index: h.order_index })
            .eq("id", h.id)
            .select("id")
        )
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) {
        if (await queueOffline(next, failed.error.message)) return;
        toast.error("สลับลำดับไม่สำเร็จ", { description: failed.error.message });
        setMics(mics);
        return;
      }
      if (results.some((r) => wroteNothing(r.data))) {
        toast.error("ยังไม่ได้บันทึก", { description: await noRowsMessage() });
        setMics(mics);
      }
      return;
    }
    const next = mics.map((m) => {
      if (m.id === a.id) return { ...m, order_index: b.order_index };
      if (m.id === b.id) return { ...m, order_index: a.order_index };
      return m;
    });
    setMics(next);
    const results = await Promise.all([
      supabase
        .from("mic_assignments")
        .update({ order_index: b.order_index })
        .eq("id", a.id)
        .select("id"),
      supabase
        .from("mic_assignments")
        .update({ order_index: a.order_index })
        .eq("id", b.id)
        .select("id"),
    ]);
    const failed = results.find((r) => r.error);
    if (failed?.error) {
      if (await queueOffline(next, failed.error.message)) return;
      toast.error("สลับลำดับไม่สำเร็จ", { description: failed.error.message });
      setMics(mics);
      return;
    }
    // No error but zero rows on either write = sent anon after a failed token
    // refresh — the swap never reached the DB. See lib/write-guard.ts.
    if (results.some((r) => wroteNothing(r.data))) {
      toast.error("ยังไม่ได้บันทึก", { description: await noRowsMessage() });
      setMics(mics);
    }
  }

  const songsWithMics = setlist.filter((s) => (s.mic_slots?.length ?? 0) > 0);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* Base mic map */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mic2 aria-hidden className="h-5 w-5" /> Mic Map
            <SaveStatus state={save.state} className="ml-auto font-sans normal-case tracking-normal" />
          </CardTitle>
          <p className="text-[13px] text-muted-foreground">ไมค์ → สมาชิก</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {members.length > 0 && (
            <datalist id="member-names">
              {members.map((m) => (
                <option key={m.id} value={m.nickname || m.name} />
              ))}
            </datalist>
          )}

          {/* "No row for this show" is not "no mics": the members' own numbers are the
              plan until someone adjusts it for this show. Read-only here — adjusting
              is เพิ่มไมค์ below. */}
          {groups.length === 0 && standing.length === 0 && (
            <p className="rounded-[2px] border border-dashed py-8 text-center text-sm text-muted-foreground">
              ยังไม่มีการกำหนดไมค์
            </p>
          )}

          {standing.length > 0 && (
            <>
              <div className="grid grid-cols-3 gap-[3px]">
                {standing.map((s) => (
                  <MicTile
                    key={s.num}
                    mic={s.num}
                    name={s.name || "—"}
                    color={s.color}
                    className={MIC_TILE_CLS}
                  />
                ))}
              </div>
              <p className="text-[12.5px] text-muted-foreground">
                ไมค์ประจำตัวสมาชิก (ยังไม่ได้ปรับเฉพาะงานนี้)
              </p>
            </>
          )}

          {/* A member reads who is on which mic: one tile per mic, number over the
              holder(s), capped in the first holder's own colour (spec §G.3). */}
          {!editable && groups.length > 0 && (
            <div className="grid grid-cols-3 gap-[3px]">
              {groups.map((g) => {
                const holders = g.holders.map((h) => h.holder_name).filter(Boolean);
                const first = members.find((x) => (x.nickname || x.name) === holders[0]);
                return (
                  <MicTile
                    key={g.num}
                    mic={g.num}
                    name={holders.join(" / ") || "—"}
                    color={first?.color ?? null}
                    className={MIC_TILE_CLS}
                  />
                );
              })}
            </div>
          )}

          {editable && groups.map((g) => (
            <div key={g.num} className="well rounded-[2px] p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm text-muted-foreground">ไมค์</span>
                <Input
                  key={`mic-${g.num}`}
                  type="number"
                  min={1}
                  defaultValue={g.num}
                  disabled={!editable}
                  aria-label={`หมายเลขไมค์ ${g.num}`}
                  className="num w-16 text-[18px]"
                  onBlur={(e) => {
                    if (!changeMicNumber(g.num, Number(e.target.value))) {
                      e.target.value = String(g.num); // revert on rejection
                    }
                  }}
                />
                {g.holders.length > 1 && (
                  <Badge variant="secondary">
                    <Mic2 aria-hidden />
                    วนไมค์ {g.holders.length} คน
                  </Badge>
                )}
                {editable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="ml-auto text-destructive hover:text-destructive"
                    aria-label={`ลบไมค์ ${g.num}`}
                    onClick={() => removeMic(g.num)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <div className="space-y-2">
                {g.holders.map((h, i) => (
                  <div key={h.id} className="flex items-center gap-2">
                    {g.holders.length > 1 && (
                      <span className="num w-5 text-center text-[14px] text-muted-foreground">
                        {i + 1}
                      </span>
                    )}
                    <Input
                      list="member-names"
                      value={h.holder_name}
                      disabled={!editable}
                      aria-label={
                        g.holders.length > 1
                          ? `ผู้ถือไมค์ ${g.num} คนที่ ${i + 1}`
                          : `ผู้ถือไมค์ ${g.num}`
                      }
                      placeholder="ชื่อสมาชิก"
                      onChange={(e) =>
                        setMics((prev) =>
                          prev.map((m) =>
                            m.id === h.id
                              ? { ...m, holder_name: e.target.value }
                              : m
                          )
                        )
                      }
                      onBlur={(e) =>
                        persist(h.id, { holder_name: e.target.value })
                      }
                    />
                    {editable && (
                      <>
                        {g.holders.length > 1 && (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => moveHolder(g.num, i, -1)}
                              disabled={i === 0}
                              aria-label="เลื่อนขึ้น"
                            >
                              <ChevronUp className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => moveHolder(g.num, i, 1)}
                              disabled={i === g.holders.length - 1}
                              aria-label="เลื่อนลง"
                            >
                              <ChevronDown className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          aria-label={`เอา ${h.holder_name || "ผู้ถือ"} ออกจากไมค์ ${g.num}`}
                          onClick={() => removeHolder(h.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </div>
                ))}
                {editable && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={inserting}
                    onClick={() => addHolder(g.num)}
                  >
                    <Plus aria-hidden className="h-4 w-4" /> เพิ่มคน (วนไมค์)
                  </Button>
                )}
              </div>
            </div>
          ))}

          {editable && (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              disabled={inserting}
              onClick={addMic}
            >
              <Plus aria-hidden className="h-4 w-4" /> เพิ่มไมค์
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Per-song summary (derived from setlist) */}
      <Card>
        <CardHeader>
          <CardTitle>Per Song</CardTitle>
          <p className="text-[13px] text-muted-foreground">สรุปไมค์แยกตามเพลง</p>
        </CardHeader>
        <CardContent>
          {songsWithMics.length === 0 ? (
            <p className="rounded-[2px] border border-dashed py-8 text-center text-sm text-muted-foreground">
              ไม่มีการสลับไมค์รายเพลง — ใช้ไมค์ตาม Mic Map
            </p>
          ) : (
            <div className="stack">
              {songsWithMics.map((s) => (
                <div key={s.id} className="slab p-3">
                  <p className="mb-1.5 font-medium">{s.title}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(s.mic_slots ?? []).map((slot, i) => (
                      <Badge key={i} variant="secondary" className="font-normal">
                        <span className="num text-[14px] text-foreground">{slot.mic}</span>
                        <span className="text-muted-foreground">→</span>
                        {slot.member}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
