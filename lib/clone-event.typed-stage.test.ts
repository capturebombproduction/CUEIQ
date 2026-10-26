// "ก๊อปงาน" asks "เวลาขึ้นเวที (เว้นว่างได้)" and used that value ONLY as a shift
// target: shiftedBy = typed − anchor, applied through shiftClock — and shiftClock
// leaves a null a null. So a source with no show_start_time (Seishin had one with
// no stage time at all, measured 2026-10-01) gave a copy whose show start stayed
// NULL: the hero said ขึ้นเวที "—", the setlist had no clock, and the completeness
// gate listed "เวลาเริ่มโชว์" missing right after the user typed it.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));

import { aroundTheClock, cloneEvent, dayOrderSeconds } from "@/lib/clone-event";

type Row = Record<string, unknown>;

function fakeDb(db: Record<string, Row[]>) {
  const inserted: Record<string, Row[]> = {};
  const client = {
    from(table: string) {
      let mode: "select" | "insert" = "select";
      let filter: [string, unknown] | null = null;
      let payload: Row | Row[] | null = null;
      let single = false;
      const run = () => {
        if (mode === "select") {
          const rows = (db[table] ?? []).filter((r) => !filter || r[filter[0]] === filter[1]);
          if (single) return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "0 rows" } };
          return { data: rows, error: null };
        }
        const rows = (Array.isArray(payload) ? payload : [payload!]).map((r, i) => ({ id: `${table}-new-${i}`, ...r }));
        (inserted[table] ??= []).push(...rows);
        return { data: single ? rows[0] : rows, error: null };
      };
      const b = {
        select: () => b,
        eq: (k: string, v: unknown) => ((filter = [k, v]), b),
        insert: (p: Row | Row[]) => ((mode = "insert"), (payload = p), b),
        single: () => ((single = true), b),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      };
      return b;
    },
  };
  return { client: client as never, inserted };
}

const SRC = "src";
// Exactly what DuplicateEventButton's buildEvent copies.
const copyRow = (ev: Row) => ({
  tenant_id: ev.tenant_id, group_id: ev.group_id, name: "Next show", event_type: ev.event_type,
  venue: ev.venue, show_start_time: ev.show_start_time, hard_out_time: ev.hard_out_time,
  notes: ev.notes, map_url: ev.map_url, costume_theme: ev.costume_theme, status: "draft",
  event_date: "2026-11-01",
});
const source = (showStart: string | null, schedule: Row[]) => ({
  events: [{ id: SRC, tenant_id: "t1", group_id: "g1", event_type: "idol", show_start_time: showStart, hard_out_time: null }],
  schedule_items: schedule,
  setlist_items: [{ id: "l1", event_id: SRC, kind: "song", title: "เพลง 1" }],
  mic_assignments: [],
  event_members: [],
});
const clone = (client: never, stageStart?: string) =>
  cloneEvent(client, { sourceId: SRC, sourceLabel: "งานต้นฉบับ", buildEvent: copyRow, stageStart });

describe("cloneEvent · the stage time typed in the copy dialog", () => {
  it("becomes the copy's show start when the source had none (its stage rows still move)", async () => {
    const { client, inserted } = fakeDb(
      source(null, [
        { id: "a", event_id: SRC, kind: "on_location", start_time: "11:00:00", end_time: null },
        { id: "b", event_id: SRC, kind: "stage", start_time: "13:00:00", end_time: "13:20:00" },
      ])
    );
    const r = await clone(client, "17:30");
    expect(r.shiftedBy).toBe(4.5 * 3600);
    expect(inserted.schedule_items.find((s) => s.kind === "stage")!.start_time).toBe("17:30:00");
    expect(inserted.events[0].show_start_time).toBe("17:30:00");
  });

  it("becomes the copy's show start when the source had no stage time anywhere", async () => {
    const { client, inserted } = fakeDb(
      source(null, [{ id: "a", event_id: SRC, kind: "on_location", start_time: "11:00:00", end_time: null }])
    );
    const r = await clone(client, "17:30");
    expect(r.shiftedBy).toBeNull(); // nothing to measure the rows from — they stay
    expect(inserted.schedule_items[0].start_time).toBe("11:00:00");
    expect(inserted.events[0].show_start_time).toBe("17:30:00");
  });

  it("a source with a show start still moves it the same way as before", async () => {
    const { client, inserted } = fakeDb(source("13:00:00", []));
    await clone(client, "17:30");
    expect(inserted.events[0].show_start_time).toBe("17:30:00");
  });

  it("nothing typed leaves the copy's show start as the source had it", async () => {
    const { client, inserted } = fakeDb(source(null, []));
    await clone(client);
    expect(inserted.events[0].show_start_time).toBeNull();
  });
});

describe("a show's day, counted round the stage", () => {
  it("is the short way round the clock", () => {
    expect(aroundTheClock(23 * 3600, 30 * 60)).toBe(90 * 60); // 23:00 → 00:30 = +1:30
    expect(aroundTheClock(30 * 60, 23 * 3600)).toBe(-90 * 60);
    expect(aroundTheClock(13 * 3600, 11 * 3600)).toBe(-2 * 3600);
  });

  it("orders a late show's day call → stage → after-midnight booth, untimed last", () => {
    const anchor = 23 * 3600;
    const rows = ["00:30:00", null, "21:00:00", "23:00:00"];
    const ordered = [...rows].sort((a, b) => dayOrderSeconds(a, anchor) - dayOrderSeconds(b, anchor));
    expect(ordered).toEqual(["21:00:00", "23:00:00", "00:30:00", null]);
  });

  it("with no anchor is the plain clock", () => {
    expect(dayOrderSeconds("00:30:00", null)).toBeLessThan(dayOrderSeconds("21:00:00", null));
  });
});
