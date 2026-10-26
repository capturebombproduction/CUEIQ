// A start queued offline, then the act re-planned before the queue replays (2026-10-27,
// hunt 6).
//
// A start's drift is actual_start − planned_start, worked out on the device against the
// plan ITS board showed. The desktop caller is offline with act B planned 20:00; staff
// online push B to 20:30 in the builder; at 20:28 the caller starts B: +28 late. The replay
// used to land +28 onto a row that now says 20:30 - every device read "ช้า +28 น." for a
// show running 2 minutes early, and projected every act after B half an hour late (the
// band cards counted down that far off) until the next start. The op now carries the plan
// its drift was read against (planBasis) and the replay moves the drift by the minutes the
// plan moved, so a ± nudge merged in after the start is kept.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSupabaseFake, ok, type RecordedCall, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));

import {
  enqueueRunSeq,
  flushRunSeqOutbox,
  listRunSeqOps,
  RUNSEQ_LANDED_EVENT,
  type RunSeqLanded,
  type RunSeqOp,
} from "@/lib/run-order-outbox";

type Row = Record<string, unknown> & { id: string };

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });
}

let server: Row[];
let supa: SupabaseFake;
/** the UPDATE payloads the replay sent, in order */
let writes: { id: unknown; values: Record<string, unknown> }[];
/** the row whose next landed UPDATE loses its answer (venue wifi), or null */
let loseAnswerFor: string | null;

function useServer(rows: Row[]) {
  server = rows;
  writes = [];
  loseAnswerFor = null;
  supa = makeSupabaseFake({ session: makeSession() });
  const matches = (r: Row, call: RecordedCall) =>
    call.filters.every((f) =>
      f.op === "eq"
        ? r[f.column] === f.value
        : f.op === "is"
          ? r[f.column] == null
          : f.op === "in"
            ? (f.value as unknown[]).includes(r[f.column])
            : true
    );
  supa.setTable("run_sequence", (call: RecordedCall) => {
    if (call.verb === "update") {
      const hit = server.filter((r) => matches(r, call));
      for (const r of hit) Object.assign(r, call.values as object);
      writes.push({ id: call.eq.id, values: { ...(call.values as Record<string, unknown>) } });
      if (hit.length && loseAnswerFor === call.eq.id) {
        loseAnswerFor = null;
        return { data: null, error: { message: "TypeError: Failed to fetch" }, status: 0 };
      }
      return ok(hit.map((r) => ({ id: r.id })));
    }
    const hit = server.filter((r) => matches(r, call)).map((r) => ({ ...r }));
    return ok(call.terminal === "maybeSingle" ? (hit[0] ?? null) : hit);
  });
  h.supa = supa;
}

// EventLiveCaller's own drift rule for a start (local clock minutes)
const secOfDay = (d: Date) => d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
const clock = (s: string) => {
  const [hh, mm] = s.split(":").map(Number);
  return hh * 3600 + mm * 60;
};
const driftOf = (iso: string, planned: string) => Math.round((secOfDay(new Date(iso)) - clock(planned)) / 60);

const AT_2028 = new Date(2026, 9, 27, 20, 28, 0).toISOString(); // B pressed live, 20:28 local
const base = { festival: "Fest · 2026-10-27", topic: "runorder:t:2026-10-27:Fest" };

const rowB = (planned: string, over: Partial<Row> = {}): Row => ({
  id: "B",
  sort_order: 2,
  status: "pending",
  planned_start: planned,
  actual_start: null,
  actual_end: null,
  offset_min: null,
  buffer_seconds: 0,
  ...over,
});

/** The start exactly as EventLiveCaller.queueOffline enqueues it (board showing 20:00). */
const queueStartOfB = (extra: Partial<RunSeqOp> = {}) =>
  enqueueRunSeq({
    ...base,
    queuedAt: 1,
    presses: ["p1"],
    rowId: "B",
    label: "B",
    patch: { status: "live", actual_start: AT_2028, offset_min: driftOf(AT_2028, "20:00") },
    expect: { status: "pending" },
    planBasis: "20:00:00",
    ...extra,
  });

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
});

describe("a start replayed onto an act re-planned while it waited", () => {
  it("lands the drift against the plan the row now holds", async () => {
    expect(driftOf(AT_2028, "20:00")).toBe(28);
    useServer([rowB("20:30:00")]);
    await queueStartOfB();

    await flushRunSeqOutbox();

    const b = server[0];
    expect(b).toMatchObject({ status: "live", actual_start: AT_2028 });
    expect(b.offset_min).toBe(driftOf(AT_2028, "20:30")); // −2: early, not 28 late
    expect(await listRunSeqOps()).toEqual([]);
  });

  it("keeps a ± nudge pressed after the start: only the plan's move is taken out", async () => {
    useServer([rowB("20:30:00")]);
    await queueStartOfB();
    // +5 pressed offline on the live act - folded into the start (planBasis kept)
    await enqueueRunSeq({ ...base, queuedAt: 2, presses: ["p2"], rowId: "B", label: "B", patch: { offset_min: 33 }, expect: { status: "live", offset_min: 28 } });

    await flushRunSeqOutbox();

    expect(server[0].offset_min).toBe(driftOf(AT_2028, "20:30") + 5); // 3
  });

  it("an unchanged plan replays exactly as before: the queued values, untouched", async () => {
    useServer([rowB("20:00:00")]);
    await queueStartOfB();
    const queued = (await listRunSeqOps())[0].patch;

    await flushRunSeqOutbox();

    expect(writes).toEqual([{ id: "B", values: queued }]);
    expect(server[0]).toMatchObject({ status: "live", actual_start: AT_2028, offset_min: 28 });
  });

  it("a record queued before plan bases existed replays as before", async () => {
    useServer([rowB("20:30:00")]);
    await queueStartOfB({ planBasis: undefined });

    await flushRunSeqOutbox();

    expect(server[0].offset_min).toBe(28);
  });

  it("a moved start whose answer was lost counts as landed next time, not as a conflict", async () => {
    useServer([rowB("20:30:00")]);
    await queueStartOfB();
    loseAnswerFor = "B";
    await flushRunSeqOutbox(); // landed on the server, the answer never came back
    expect(server[0].offset_min).toBe(-2);
    expect((await listRunSeqOps()).map((o) => o.conflict ?? false)).toEqual([false]);

    await flushRunSeqOutbox();

    expect(await listRunSeqOps()).toEqual([]);
    expect(server[0].offset_min).toBe(-2);
  });

  it("a moved start that landed unanswered, then ended offline: the whole จบ + ต่อไป still lands", async () => {
    useServer([
      { id: "A", sort_order: 1, status: "live", planned_start: "19:30:00", actual_start: "2026-10-27T12:30:00.000Z", actual_end: null, offset_min: 0, buffer_seconds: 0 },
      rowB("20:30:00"),
      { id: "C", sort_order: 3, status: "pending", planned_start: "21:10:00", actual_start: null, actual_end: null, offset_min: null, buffer_seconds: 0 },
    ]);
    // จบ + ต่อไป (A → B) offline
    await enqueueRunSeq({ ...base, queuedAt: 1, presses: ["p1"], rowId: "A", label: "A", patch: { status: "done", actual_end: AT_2028 }, expect: { status: "live" } });
    await queueStartOfB();
    loseAnswerFor = "B";
    await flushRunSeqOutbox(); // A lands; B lands moved (−2) but its answer is lost
    expect(server[1].offset_min).toBe(-2);
    // still offline on the board (which says +28): จบ + ต่อไป (B → C)
    const AT_2110 = new Date(2026, 9, 27, 21, 10, 0).toISOString();
    await enqueueRunSeq({ ...base, queuedAt: 2, presses: ["p3"], rowId: "B", label: "B", patch: { status: "done", actual_end: AT_2110 }, expect: { status: "live" } });
    await enqueueRunSeq({ ...base, queuedAt: 2, presses: ["p3"], rowId: "C", label: "C", patch: { status: "live", actual_start: AT_2110, offset_min: 0 }, expect: { status: "pending" }, planBasis: "21:10:00" });

    await flushRunSeqOutbox();

    // judged against the moved version the row holds - not parked as someone else's doing
    expect(await listRunSeqOps()).toEqual([]);
    expect(server[1]).toMatchObject({ status: "done", actual_end: AT_2110, offset_min: -2 });
    expect(server[2]).toMatchObject({ status: "live", actual_start: AT_2110, offset_min: 0 });
  });

  it("the copies of the board are told the drift the server took", async () => {
    useServer([rowB("20:30:00")]);
    await queueStartOfB();
    const landed: RunSeqLanded[] = [];
    const on = (e: Event) => landed.push((e as CustomEvent<RunSeqLanded>).detail);
    window.addEventListener(RUNSEQ_LANDED_EVENT, on);
    try {
      await flushRunSeqOutbox();
    } finally {
      window.removeEventListener(RUNSEQ_LANDED_EVENT, on);
    }
    expect(landed).toHaveLength(1);
    expect(landed[0].patch.offset_min).toBe(-2);
  });
});
