"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Plus, Trash2, ArrowUp, ArrowDown, Download, ImageDown } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { captureElementToImage } from "@/lib/export-image";

export type RunSequence = {
  id: string;
  tenant_id: string;
  event_name: string;
  event_date: string | null;
  sort_order: number;
  title: string;
  kind: string;
  planned_start: string | null; // "HH:MM[:SS]"
  planned_end: string | null;
  buffer_seconds: number;
  linked_event_id: string | null;
};

// ONE ENTRY PER STAGE SLOT. `id` is the band's EVENT id (what linked_event_id points
// at) and is therefore NOT unique here: a band booked twice on one festival day
// appears twice, once per slot — mig 0036 caps only 'photo' at one row per event.
export type RunBandEvent = {
  id: string;
  group_name: string;
  stage_start: string | null; // "HH:MM:SS" — THIS slot's window
  stage_end: string | null;
};

// The kinds a running-order line can be — a band slot, a game, a ceremony, MC, a
// break, or anything else. Drives the Phase-2 live caller's colour/grouping later.
const KINDS: { value: string; label: string }[] = [
  { value: "band", label: "วง (Band)" },
  { value: "game", label: "เกม/กิจกรรม" },
  { value: "ceremony", label: "พิธี" },
  { value: "mc", label: "MC" },
  { value: "break", label: "Break" },
  { value: "other", label: "อื่นๆ" },
];

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : "");
const selCls = "rounded-md border bg-background px-2 py-1.5 text-sm";

// Shown when a write came back clean but touched 0 rows — see the .select("id") note
// on persist(). There's no error text to quote, and 0 rows has three very different
// causes (no permission / row gone / the request went out unsigned, see
// hasLiveSession), so name all three and promise only what we actually do next: ask
// the server again. Never claim the screen was refreshed — runRollback() deliberately
// keeps the current rows when the answer can't be trusted.
const NO_ROW_HINT =
  "ไม่มีสิทธิ์แก้ลำดับ แถวถูกลบไปแล้ว หรือยังยืนยันบัญชีไม่ได้ — กำลังตรวจกับเซิร์ฟเวอร์อีกครั้ง";

/**
 * Builds the festival-wide running order (run_sequence rows) the staff will run live
 * in Phase 2. Autosaves each field like the setlist/staff-contacts editors; reorder
 * by swapping sort_order with the neighbour. "นำเข้าจากเวทีวง" seeds a band line per
 * stage slot so the staff don't retype the line-up.
 */
export function RunOrderBuilder({
  tenantId,
  eventName,
  eventDate,
  initial,
  bandEvents,
}: {
  tenantId: string;
  eventName: string;
  eventDate: string | null;
  initial: RunSequence[];
  bandEvents: RunBandEvent[];
}) {
  const supabase = createClient();
  const confirm = useConfirm();
  const [rows, setRows] = useState<RunSequence[]>(initial);
  const [busy, setBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Same broadcast channel the live boards (EventLiveCaller / EventRunStatusCard)
  // listen on — every successful edit here sends "changed" so an OPEN live board
  // refetches immediately (staff fixing the order mid-show must not go stale).
  // The builder only sends; it never refetches itself.
  const channelRef = useRef<RealtimeChannel | null>(null);
  const meId = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Math.random())
  );
  useEffect(() => {
    const ch = supabase.channel(
      `runorder:${tenantId}:${eventDate ?? "x"}:${encodeURIComponent(eventName)}`,
      { config: { broadcast: { self: false } } }
    );
    ch.subscribe();
    channelRef.current = ch;
    return () => {
      channelRef.current = null;
      supabase.removeChannel(ch);
    };
  }, [supabase, tenantId, eventName, eventDate]);
  function bcast() {
    channelRef.current?.send({
      type: "broadcast",
      event: "changed",
      payload: { sender: meId.current },
    });
  }

  function setLocal(id: string, partial: Partial<RunSequence>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...partial } : r)));
  }

  // --- write / rollback ordering ----------------------------------------------
  // A rollback REPLACES every row, so it needs the same ordering discipline as the
  // live board's refetch() (components/event/event-live-caller.tsx): `writesInFlight`
  // defers it while one of our own writes is still un-acked — a read taken now can
  // predate that write and would undo it — and `rollbackSeq` drops a snapshot a newer
  // write (or a newer rollback) has already superseded. The pending record survives
  // both, so whichever write settles last re-runs the rollback.
  const rollbackSeqRef = useRef(0);
  const writesInFlightRef = useRef(0);
  // `fallback` = the rows as they were BEFORE the failed edit, restored only when the
  // server can't be reached at all. Nulled as soon as a LATER write goes out: from
  // then on the snapshot predates something we asked the DB to keep, so only server
  // truth may replace the rows.
  const pendingRollbackRef = useRef<{ fallback: RunSequence[] | null } | null>(null);
  // The title box types into local state and only saves on blur, so swapping in server
  // rows mid-typing would silently throw away what's on the keyboard. Remember the row
  // being typed in and keep its local title whenever the rows are replaced.
  const typingIdRef = useRef<string | null>(null);

  /** Run one write inside the gate above — via finally, so a throw can't wedge it. */
  async function guarded<T>(run: () => PromiseLike<T>): Promise<T> {
    writesInFlightRef.current++;
    rollbackSeqRef.current++; // any rollback read in flight predates this write…
    const pending = pendingRollbackRef.current;
    if (pending) pending.fallback = null; // …and so does the snapshot it still holds
    try {
      return await run();
    } finally {
      writesInFlightRef.current--;
      // run whatever rollback was deferred while this write was in flight
      if (writesInFlightRef.current === 0 && pendingRollbackRef.current) void runRollback();
    }
  }

  // Ask the same question supabase-js asks before it signs a request: is there a
  // usable access token? A FAILED token refresh is silent — the client falls back to
  // the ANON key (auth-js caches the failure for ~a minute, exactly the window a venue
  // reconnect lands in) and RLS then answers a SELECT with [] instead of an error.
  // Same guard as hasLiveSession() in desktop/src/data/mgmt-outbox.ts; that module is
  // desktop-only, so the check is repeated here against the shared client. Only called
  // after a read that already came back cleanly, so getSession()'s offline
  // refresh-hang (see desktop/src/data/stored-session.ts) can't stall a rollback.
  async function hasLiveSession(): Promise<boolean> {
    try {
      const { data } = await supabase.auth.getSession();
      return !!data.session?.access_token;
    } catch {
      return false;
    }
  }

  /** Swap in a whole set of rows, keeping the title that is being typed right now. */
  function applyRows(next: RunSequence[]) {
    const typingId = typingIdRef.current;
    if (!typingId) {
      setRows(next);
      return;
    }
    setRows((prev) => {
      const typing = prev.find((r) => r.id === typingId);
      return typing
        ? next.map((r) => (r.id === typing.id ? { ...r, title: typing.title } : r))
        : next;
    });
  }

  // Pull the order back to server truth after a write that didn't land. Every edit
  // here is optimistic and the live คุมคิว board reads the DB, so a builder still
  // showing a change the DB never got makes the show-caller announce the wrong act —
  // and a reload silently reverts what the staff believe they saved. Mirrors apply()'s
  // rollback in components/event/event-live-caller.tsx.
  async function scheduleRollback(fallback: RunSequence[]) {
    pendingRollbackRef.current = {
      // A snapshot is only a safe restore point while nothing else is un-acked:
      // another write in flight may still land, and this snapshot predates it.
      fallback: writesInFlightRef.current === 0 ? fallback : null,
    };
    if (writesInFlightRef.current > 0) return; // guarded()'s tail runs it
    await runRollback();
  }

  async function runRollback() {
    const pending = pendingRollbackRef.current;
    if (!pending || writesInFlightRef.current > 0) return;
    const seq = ++rollbackSeqRef.current;
    const readOrder = () => {
      const q = supabase
        .from("run_sequence")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("event_name", eventName)
        .order("sort_order", { ascending: true });
      return eventDate ? q.eq("event_date", eventDate) : q.is("event_date", null);
    };
    const { data, error } = await readOrder();
    // Superseded while the read was in flight — this snapshot predates that write, so
    // drop it; `pending` stays queued and guarded()'s tail re-reads once it settles.
    if (seq !== rollbackSeqRef.current || writesInFlightRef.current > 0) return;
    if (!error && data && data.length > 0) {
      pendingRollbackRef.current = null;
      applyRows(data as RunSequence[]);
      return;
    }
    if (!error && data) {
      // An EMPTY read is NOT proof the order is gone: under the anon fallback above,
      // RLS answers [] for every row. Wiping on that empties the whole festival order
      // — and the next “นำเข้าจากเวทีวง”, which reads linked_event_id off these very
      // rows, would then insert every act a second time and broadcast the duplicate to
      // the live board. The SELECT policy is is_tenant_member (mig 0033), so WITH a
      // live session [] really does mean someone else cleared the order; without one,
      // believe nothing.
      const live = await hasLiveSession();
      if (seq !== rollbackSeqRef.current || writesInFlightRef.current > 0) return;
      if (live) {
        // hasLiveSession() answers "is there a usable token NOW", not "was THAT read
        // signed" — and getSession() can mint one itself, so the read above may still
        // have gone out anon inside the cached-refresh cooldown and come back [] from
        // RLS. Ask once more now that a token provably exists: only an empty answer
        // from a read we know was signed is allowed to wipe the order.
        const second = await readOrder();
        if (seq !== rollbackSeqRef.current || writesInFlightRef.current > 0) return;
        if (!second.error && second.data && second.data.length > 0) {
          pendingRollbackRef.current = null;
          applyRows(second.data as RunSequence[]);
          return;
        }
        if (!second.error && second.data) {
          pendingRollbackRef.current = null;
          applyRows([]);
          return;
        }
      }
    }
    // Server unreachable (the classic venue Wi-Fi drop) or an answer we can't trust:
    // put the pre-edit rows back so the screen stops showing a change the DB never
    // took. No snapshot left to trust → leave the rows alone rather than guess.
    pendingRollbackRef.current = null;
    if (pending.fallback) applyRows(pending.fallback);
  }

  // `snap` = the rows as they were BEFORE the optimistic edit. The title field types
  // straight into local state and only persists on blur, so it has no pre-edit
  // snapshot to offer — there the re-read is the only truth we can restore, and the
  // current rows are passed just so an offline rollback is a no-op instead of a wipe.
  async function persist(
    id: string,
    partial: Partial<RunSequence>,
    snap: RunSequence[] = rows
  ) {
    // Select the row back: an UPDATE that RLS FILTERS OUT returns 204 with no error
    // and 0 rows, so the error check alone would take the success path. run_sequence's
    // update policy is can_approve(tenant_id) (mig 0033) and the desktop builder gates
    // on cached perms, so a demoted account still sees the full builder and has every
    // write silently dropped. 0 rows also means another device deleted the row. Same
    // guard as apply()'s `losers` in components/event/event-live-caller.tsx.
    const { data, error } = await guarded(() =>
      supabase.from("run_sequence").update(partial).eq("id", id).select("id")
    );
    if (error || (data?.length ?? 0) === 0) {
      toast.error("บันทึกไม่สำเร็จ", { description: error?.message ?? NO_ROW_HINT });
      await scheduleRollback(snap); // never broadcast an edit the DB doesn't have
      return;
    }
    bcast();
  }
  function update(id: string, partial: Partial<RunSequence>) {
    const snap = rows;
    setLocal(id, partial);
    persist(id, partial, snap);
  }

  async function addRow() {
    setBusy(true);
    const sort = rows.length ? Math.max(...rows.map((r) => r.sort_order)) + 1 : 1;
    // Through the gate like every other write: a rollback read issued BEFORE this
    // insert would otherwise land after it and drop the new row off the screen while
    // it sits in the DB — and “นำเข้าจากเวทีวง” would then re-add its band.
    const { data, error } = await guarded(() =>
      supabase
        .from("run_sequence")
        .insert({
          tenant_id: tenantId,
          event_name: eventName,
          event_date: eventDate,
          sort_order: sort,
          title: "",
          kind: "other",
        })
        .select("*")
        .single()
    );
    setBusy(false);
    if (error || !data) {
      toast.error("เพิ่มไม่สำเร็จ", { description: error?.message });
      return;
    }
    setRows((prev) => [...prev, data as RunSequence]);
    bcast();
  }

  async function removeRow(id: string) {
    const ok = await confirm({
      title: "ลบลำดับนี้?",
      description: "แถวนี้จะถูกลบออกจาก running order",
    });
    if (!ok) return;
    const snap = rows;
    setRows((prev) => prev.filter((r) => r.id !== id));
    // Same 0-row hole as persist(): the delete policy is can_approve(tenant_id) too.
    // Roll back from the SERVER (not straight to `snap`) so a row someone else already
    // deleted stays gone instead of reappearing, while a denied delete comes back.
    const { data, error } = await guarded(() =>
      supabase.from("run_sequence").delete().eq("id", id).select("id")
    );
    if (error || (data?.length ?? 0) === 0) {
      toast.error("ลบไม่สำเร็จ", { description: error?.message ?? NO_ROW_HINT });
      await scheduleRollback(snap);
    } else {
      bcast();
    }
  }

  // Reorder by swapping sort_order with the neighbour (same trick the rest of the app
  // uses — no full re-index needed).
  async function move(id: string, dir: -1 | 1) {
    const sorted = [...rows].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sorted.findIndex((r) => r.id === id);
    const j = idx + dir;
    if (j < 0 || j >= sorted.length) return;
    const a = sorted[idx];
    const b = sorted[j];
    const snap = rows;
    setRows((prev) =>
      prev.map((r) =>
        r.id === a.id
          ? { ...r, sort_order: b.sort_order }
          : r.id === b.id
            ? { ...r, sort_order: a.sort_order }
            : r
      )
    );
    const results = await guarded(() =>
      Promise.all([
        supabase
          .from("run_sequence")
          .update({ sort_order: b.sort_order })
          .eq("id", a.id)
          .select("id"),
        supabase
          .from("run_sequence")
          .update({ sort_order: a.sort_order })
          .eq("id", b.id)
          .select("id"),
      ])
    );
    const err = results.find((r) => r.error)?.error;
    // …and the same 0-row check as persist(): a swap RLS filtered out reports no error.
    const noRow = results.some((r) => !r.error && (r.data?.length ?? 0) === 0);
    if (err || noRow) {
      // Half a swap may have landed — the two updates are separate statements with no
      // transaction — so the re-read (not the snapshot) decides what this screen shows.
      // Still BROADCAST when either statement touched a row: the DB really did move and
      // the live คุมคิว board must re-read, or it announces from an order that no longer
      // exists. A broadcast only asks receivers to re-read, so a spare one is free while
      // a missing one is not (same discipline as apply() in event-live-caller.tsx).
      const anyLanded = results.some((r) => !r.error && (r.data?.length ?? 0) > 0);
      toast.error("สลับลำดับไม่สำเร็จ", { description: err?.message ?? NO_ROW_HINT });
      if (anyLanded) bcast();
      await scheduleRollback(snap);
      return;
    }
    bcast();
  }

  // Seed a band line per stage slot not already on the order, in stage-time order.
  // bandEvents holds one entry PER SLOT, so a band with an afternoon AND an evening
  // slot gets BOTH lines — de-duping on linked_event_id alone (what this did) gave it
  // one, and the missing slot was simply never called on the day.
  async function importBands() {
    const slots = bandEvents
      .filter((b) => b.stage_start)
      .sort((x, y) => (x.stage_start! < y.stage_start! ? -1 : 1));
    const perBand = new Map<string, RunBandEvent[]>(); // this band's slots, in play order
    for (const b of slots) {
      const list = perBand.get(b.id);
      if (list) list.push(b);
      else perBand.set(b.id, [b]);
    }
    const linesBy = new Map<string, RunSequence[]>(); // …and the lines it already has
    for (const r of rows) {
      if (!r.linked_event_id) continue;
      const list = linesBy.get(r.linked_event_id);
      if (list) list.push(r);
      else linesBy.set(r.linked_event_id, [r]);
    }
    const toMin = (t: string | null) => {
      if (!t) return null;
      const [h, m] = t.split(":");
      const v = Number(h) * 60 + Number(m);
      return Number.isFinite(v) ? v : null;
    };
    // PAIR every existing line to the slot it stands for, then import only the slots
    // nobody claimed. Merely COUNTING the lines would say how many slots are missing
    // but not WHICH: a band whose 13:00 line a staffer had nudged to 13:10 would get
    // 13:00 re-added — double-booking the afternoon on the live board — and the 18:00
    // that really is missing suppressed by the count.
    //  1. an exact (band, HH:MM) match claims its own slot — the reliable case.
    //     planned_start comes back "HH:MM:SS" from the DB but the time input writes
    //     "HH:MM" into local state, so both sides compare on hhmm();
    //  2. each remaining line then claims its NEAREST unclaimed slot, because a
    //     hand-moved time still stands for that slot. A line with no time at all
    //     claims the first unclaimed one — that's the old behaviour for a band
    //     linked to a timeless row, kept.
    const claimed = new Map<string, boolean[]>();
    for (const [bandId, bandSlots] of perBand) {
      const marks = bandSlots.map(() => false);
      claimed.set(bandId, marks);
      const leftover: RunSequence[] = [];
      for (const r of linesBy.get(bandId) ?? []) {
        const exact = bandSlots.findIndex(
          (s, k) => !marks[k] && hhmm(s.stage_start) === hhmm(r.planned_start)
        );
        if (exact >= 0) marks[exact] = true;
        else leftover.push(r);
      }
      for (const r of leftover) {
        const at = toMin(r.planned_start);
        let best = -1;
        let bestGap = Infinity;
        for (let k = 0; k < bandSlots.length; k++) {
          if (marks[k]) continue;
          // no time on the line → gap 0 everywhere, so the FIRST unclaimed slot wins
          const gap = at === null ? 0 : Math.abs((toMin(bandSlots[k].stage_start) ?? at) - at);
          if (gap < bestGap) {
            bestGap = gap;
            best = k;
          }
        }
        // best stays -1 when the band already has more lines than slots — that extra
        // line claims nothing, and no slot is left for it to wrongly cover.
        if (best >= 0) marks[best] = true;
      }
    }

    const seen = new Map<string, number>();
    const todo: { band: RunBandEvent; round: number | null }[] = [];
    for (const b of slots) {
      const round = (seen.get(b.id) ?? 0) + 1; // slot no. within this band, 1-based
      seen.set(b.id, round);
      if (claimed.get(b.id)?.[round - 1]) continue; // a line already stands for it
      // Only a band that really plays more than once gets the round marker, so a
      // one-slot band's line reads exactly as it always did.
      todo.push({ band: b, round: (perBand.get(b.id)?.length ?? 0) > 1 ? round : null });
    }
    if (todo.length === 0) {
      toast.info("ทุกรอบเวทีถูกเพิ่มแล้ว (หรือยังไม่มีเวลาเวที)");
      return;
    }
    setBusy(true);
    let sort = rows.length ? Math.max(...rows.map((r) => r.sort_order)) : 0;
    const created: RunSequence[] = [];
    let failed: string | undefined;
    // One gate around the WHOLE loop: a rollback landing between two inserts would
    // replace the rows with a snapshot that predates the ones already created, and the
    // next import — which reads linked_event_id + planned_start off the rows on screen
    // — would add those slots all over again. Deferred until the import finishes.
    await guarded(async () => {
      for (const { band: b, round } of todo) {
        sort += 1;
        const { data, error } = await supabase
          .from("run_sequence")
          .insert({
            tenant_id: tenantId,
            event_name: eventName,
            event_date: eventDate,
            sort_order: sort,
            // "SEISHIN (รอบ 2)" — the slot's own time sits next to it everywhere the
            // title is shown, so two lines for the same band can't be mixed up.
            title: round ? `${b.group_name} (รอบ ${round})` : b.group_name,
            kind: "band",
            planned_start: b.stage_start,
            planned_end: b.stage_end,
            linked_event_id: b.id,
          })
          .select("*")
          .single();
        if (error || !data) {
          // Stop at the first failure: pushing on would scatter half the line-up over
          // the order and leave holes in the sort numbers. The rows that DID land stay
          // (they're real), and the toast says the import is incomplete.
          failed = error?.message ?? "เพิ่มแถวไม่สำเร็จ";
          break;
        }
        created.push(data as RunSequence);
      }
      // inside the gate: the rows the inserts really created must be on screen before
      // any deferred rollback is allowed to re-read and replace them
      setRows((prev) => [...prev, ...created]);
    });
    setBusy(false);
    if (created.length > 0) bcast();
    if (failed) {
      // Counted in slots, not bands — one band can contribute more than one line.
      toast.error(`นำเข้าไม่ครบ — เพิ่มได้ ${created.length}/${todo.length} รอบ`, {
        description: failed,
      });
    } else {
      toast.success(`เพิ่ม ${created.length} รอบเวที`);
    }
  }

  // Save the whole running order as a clean light-theme JPG to share with the band
  // members / crew (like the organiser's own timetable image). Captures the
  // off-screen card below; no `now`/timezone data in it, so no hydration gate needed.
  async function exportImage() {
    const el = cardRef.current;
    if (!el) return;
    setExportBusy(true);
    try {
      const safe = eventName.replace(/[^\w\-]+/g, "_") || "run-order";
      const how = await captureElementToImage(el, {
        filename: `${safe}_runorder.jpg`,
        shareTitle: `${eventName} — ลำดับงาน`,
        width: 600,
      });
      if (how === "cancelled") return; // user dismissed the share sheet — nothing was saved
      toast.success(how === "shared" ? "แชร์รูปแล้ว" : "บันทึกรูปแล้ว 🖼️");
    } catch (e) {
      toast.error("บันทึกรูปไม่สำเร็จ", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setExportBusy(false);
    }
  }

  const ordered = [...rows].sort((a, b) => a.sort_order - b.sort_order);

  // The link dropdown picks an EVENT, but bandEvents now holds one entry per stage
  // slot — rendering it straight would give a twice-booked band two options with the
  // SAME value, and a <select> then shows the first matching option's label whichever
  // one was picked. So: one option per event, with the slot times in the label when
  // there's more than one (that's what tells the staffer this band plays twice).
  const bandOptions: { id: string; label: string }[] = [];
  const optStarts = new Map<string, string[]>();
  for (const b of bandEvents) {
    const starts = optStarts.get(b.id);
    if (starts) {
      if (b.stage_start) starts.push(hhmm(b.stage_start));
    } else {
      optStarts.set(b.id, b.stage_start ? [hhmm(b.stage_start)] : []);
      bandOptions.push({ id: b.id, label: b.group_name });
    }
  }
  for (const o of bandOptions) {
    const starts = optStarts.get(o.id) ?? [];
    if (starts.length > 1) o.label = `${o.label} · ${starts.join(", ")}`;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={importBands} disabled={busy}>
          <Download className="h-4 w-4" /> นำเข้าจากเวทีวง
        </Button>
        <Button size="sm" onClick={addRow} disabled={busy}>
          <Plus className="h-4 w-4" /> เพิ่มลำดับ
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={exportImage}
          disabled={busy || exportBusy || ordered.length === 0}
          title="บันทึกลำดับงานเป็นรูป ไว้แชร์ให้สมาชิกวง/ทีมงาน"
        >
          <ImageDown className="h-4 w-4" /> {exportBusy ? "กำลังสร้าง…" : "บันทึกเป็นรูป"}
        </Button>
      </div>

      {ordered.length === 0 ? (
        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          ยังไม่มีลำดับงาน — กด “นำเข้าจากเวทีวง” หรือ “เพิ่มลำดับ”
        </p>
      ) : (
        <div className="space-y-2">
          {ordered.map((r, i) => (
            <div key={r.id} className="rounded-lg border bg-card p-2">
              <div className="flex flex-wrap items-center gap-2">
                {/* These carried no size classes, so each button collapsed to its
                    16px icon and the pair sat flush — one 16px target directly on
                    top of a 16px target that does the opposite, and they are the
                    ONLY reorder control here. A mis-tap reorders the festival
                    running order and broadcasts it to the live คุมคิว board. */}
                <div className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={() => move(r.id, -1)}
                    disabled={i === 0}
                    className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
                    aria-label="เลื่อนขึ้น"
                    title="เลื่อนขึ้น"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(r.id, 1)}
                    disabled={i === ordered.length - 1}
                    className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
                    aria-label="เลื่อนลง"
                    title="เลื่อนลง"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </div>
                <Input
                  type="time"
                  value={hhmm(r.planned_start)}
                  className="w-[7.5rem] shrink-0"
                  onChange={(e) => update(r.id, { planned_start: e.target.value || null })}
                />
                <span className="text-muted-foreground">–</span>
                <Input
                  type="time"
                  value={hhmm(r.planned_end)}
                  className="w-[7.5rem] shrink-0"
                  onChange={(e) => update(r.id, { planned_end: e.target.value || null })}
                />
                <select
                  value={r.kind}
                  onChange={(e) => update(r.id, { kind: e.target.value })}
                  className={selCls}
                >
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <Input
                  value={r.title}
                  placeholder="ชื่อลำดับ (เช่น Opening / Show Match)"
                  className="min-w-[160px] flex-1"
                  // The only field that saves on blur instead of on change — so mark it
                  // while it has focus and applyRows() won't swap the half-typed name
                  // out from under the staffer (see typingIdRef).
                  onFocus={() => {
                    typingIdRef.current = r.id;
                  }}
                  onChange={(e) => setLocal(r.id, { title: e.target.value })}
                  onBlur={(e) => {
                    // cleared BEFORE the write, so its own rollback is free to put the
                    // server's title back on this row
                    typingIdRef.current = null;
                    persist(r.id, { title: e.target.value });
                  }}
                />
                <select
                  value={r.linked_event_id ?? ""}
                  onChange={(e) => update(r.id, { linked_event_id: e.target.value || null })}
                  className={selCls}
                  title="ผูกกับวง (ดึงเวลา/เปิด setlist)"
                >
                  <option value="">— ไม่ผูกวง —</option>
                  {bandOptions.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  buffer
                  <Input
                    type="number"
                    min={0}
                    value={Math.round((r.buffer_seconds || 0) / 60)}
                    className="w-16"
                    onChange={(e) =>
                      update(r.id, {
                        buffer_seconds: Math.max(0, Number(e.target.value) || 0) * 60,
                      })
                    }
                  />
                  น.
                </label>
                <button
                  type="button"
                  onClick={() => removeRow(r.id)}
                  className="ml-auto text-destructive"
                  aria-label="ลบ"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Off-screen shareable timetable — captureElementToImage() shoots this to a
          clean light-theme JPG. Uses only server-provided planned times/titles (no
          `now`), so it's safe to render without a mounted gate. */}
      {ordered.length > 0 && (
        <div
          ref={cardRef}
          aria-hidden
          className="pointer-events-none fixed -left-[9999px] top-0 w-[600px] bg-card p-6 text-foreground"
        >
          <div className="mb-4 border-b pb-3">
            <h2 className="text-2xl font-bold tracking-tight">{eventName}</h2>
            <p className="text-sm text-muted-foreground">
              {eventDate ? `${eventDate} · ` : ""}ลำดับงาน (Running Order)
            </p>
          </div>
          <div className="divide-y">
            {ordered.map((r) => {
              const time = r.planned_start
                ? `${hhmm(r.planned_start)}${r.planned_end ? "–" + hhmm(r.planned_end) : ""}`
                : "";
              const isBand = r.kind === "band";
              return (
                <div key={r.id} className="flex items-baseline gap-3 py-2">
                  <span className="w-28 shrink-0 text-sm font-medium tabular-nums text-muted-foreground">
                    {time}
                  </span>
                  <span className={isBand ? "text-base font-semibold" : "text-sm"}>
                    {r.title || "—"}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-right text-[10px] text-muted-foreground">CueIQ</p>
        </div>
      )}
    </div>
  );
}
