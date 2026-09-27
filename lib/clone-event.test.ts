import { describe, it, expect, vi, beforeEach } from "vitest";

const session = vi.hoisted(() => ({ live: true }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => session.live }));

import { cloneEvent, shiftClock, stageAnchorSeconds } from "./clone-event";

type Row = Record<string, unknown>;

/** Just enough of the supabase query builder for cloneEvent: select/eq/single
 *  reads, insert(+select+single) writes, each awaited as { data, error }. */
function fakeDb(
  db: Record<string, Row[]>,
  { failRead = [] as string[], failInsert = [] as string[] } = {}
) {
  const inserted: Record<string, Row[]> = {};
  const client = {
    from(table: string) {
      let mode: "select" | "insert" = "select";
      let filter: [string, unknown] | null = null;
      let payload: Row | Row[] | null = null;
      let single = false;
      const run = () => {
        if (mode === "select") {
          if (failRead.includes(table)) return { data: null, error: { message: "boom" } };
          const rows = (db[table] ?? []).filter((r) => !filter || r[filter[0]] === filter[1]);
          if (single) return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "0 rows" } };
          return { data: rows, error: null };
        }
        if (failInsert.includes(table)) return { data: null, error: { message: "denied" } };
        const rows = (Array.isArray(payload) ? payload : [payload!]).map((r, i) => ({
          id: `${table}-new-${i}`,
          ...r,
        }));
        (inserted[table] ??= []).push(...rows);
        return { data: single ? rows[0] : rows, error: null };
      };
      const b = {
        select: () => b,
        eq: (k: string, v: unknown) => ((filter = [k, v]), b),
        insert: (p: Row | Row[]) => ((mode = "insert"), (payload = p), b),
        single: () => ((single = true), b),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(res, rej),
      };
      return b;
    },
  };
  return { client: client as never, inserted };
}

const SRC = "src";
const show = (): Record<string, Row[]> => ({
  events: [{ id: SRC, tenant_id: "t1", group_id: "g1", name: "Sourgrumy" }],
  schedule_items: [{ id: "s1", event_id: SRC, tenant_id: "t1", kind: "stage", start_time: "17:00:00" }],
  setlist_items: [
    { id: "l1", event_id: SRC, tenant_id: "t1", title: "I Am Who I Am", song_id: "song-1", audio_path: "x.wav", audio_name: "x.wav" },
  ],
  mic_assignments: [],
  event_members: [
    { id: "m1", event_id: SRC, tenant_id: "t1", member_id: "aya", created_at: "2026-09-01" },
    { id: "m2", event_id: SRC, tenant_id: "t1", member_id: "bell", created_at: "2026-09-01" },
  ],
});
const build = (src: Row) => ({ tenant_id: src.tenant_id, group_id: src.group_id, name: "Next show", event_date: "2026-10-05" });

beforeEach(() => {
  session.live = true;
});

describe("cloneEvent", () => {
  it("copies schedule, setlist and the LINEUP into the new show, reparented and stripped", async () => {
    const { client, inserted } = fakeDb(show());
    const r = await cloneEvent(client, { sourceId: SRC, sourceLabel: "งานต้นฉบับ", buildEvent: build });

    expect(r).toEqual({ newId: "events-new-0", failed: [], attempted: 3, shiftedBy: 0 });
    expect(inserted.events).toEqual([{ id: "events-new-0", ...build(show().events[0]) }]);
    expect(inserted.event_members.map((m) => [m.event_id, m.member_id, m.tenant_id])).toEqual([
      ["events-new-0", "aya", "t1"],
      ["events-new-0", "bell", "t1"],
    ]);
    // the song link survives; the per-show audio upload does not
    expect(inserted.setlist_items[0]).toMatchObject({ event_id: "events-new-0", song_id: "song-1" });
    expect(inserted.setlist_items[0]).not.toHaveProperty("audio_path");
    expect(inserted.schedule_items[0]).toMatchObject({ event_id: "events-new-0", kind: "stage" });
    // an empty part is simply skipped, not attempted
    expect(inserted.mic_assignments).toBeUndefined();
  });

  it("a failed read creates NOTHING — no empty show under a success toast", async () => {
    const { client, inserted } = fakeDb(show(), { failRead: ["setlist_items"] });
    await expect(
      cloneEvent(client, { sourceId: SRC, sourceLabel: "งานต้นฉบับ", buildEvent: build })
    ).rejects.toThrow(/เซ็ตลิสต์/);
    expect(inserted.events).toBeUndefined();
  });

  it("every part empty with the session gone reads as anon-degraded — creates nothing", async () => {
    session.live = false;
    const db = { ...show(), schedule_items: [], setlist_items: [], event_members: [] };
    const { client, inserted } = fakeDb(db);
    await expect(
      cloneEvent(client, { sourceId: SRC, sourceLabel: "งานต้นฉบับ", buildEvent: build })
    ).rejects.toThrow(/เซสชันหมดอายุ/);
    expect(inserted.events).toBeUndefined();
  });

  it("a genuinely bare source still copies while the session is live", async () => {
    const db = { ...show(), schedule_items: [], setlist_items: [], event_members: [] };
    const { client } = fakeDb(db);
    const r = await cloneEvent(client, { sourceId: SRC, sourceLabel: "งานต้นฉบับ", buildEvent: build });
    expect(r).toEqual({ newId: "events-new-0", failed: [], attempted: 0, shiftedBy: 0 });
  });

  it("a part that fails to insert is named, and the rest still copy", async () => {
    const { client, inserted } = fakeDb(show(), { failInsert: ["event_members"] });
    const r = await cloneEvent(client, { sourceId: SRC, sourceLabel: "งานต้นฉบับ", buildEvent: build });
    expect(r.failed).toEqual(["รายชื่อคนมา"]);
    expect(r.attempted).toBe(3);
    expect(inserted.setlist_items).toHaveLength(1);
  });

  it("a missing source creates nothing", async () => {
    const { client, inserted } = fakeDb(show());
    await expect(
      cloneEvent(client, { sourceId: "nope", sourceLabel: "แม่แบบ", buildEvent: build })
    ).rejects.toThrow(/ไม่พบแม่แบบ/);
    expect(inserted.events).toBeUndefined();
  });
});

// The 27 Sep show as it really was: arrive/dressing 120 min before the stage,
// photo 70, STB 15, the 20-minute slot, the booth after.
const realDay = (): Record<string, Row[]> => ({
  events: [
    { id: SRC, tenant_id: "t1", group_id: "g1", name: "Thailand hobbyfestival", show_start_time: "13:00:00", hard_out_time: "13:20:00" },
  ],
  schedule_items: [
    { id: "a", event_id: SRC, kind: "on_location", start_time: "11:00:00", end_time: null },
    { id: "b", event_id: SRC, kind: "dressing_room", start_time: "11:00:00", end_time: null },
    { id: "c", event_id: SRC, kind: "photo", start_time: "11:50:00", end_time: null },
    { id: "d", event_id: SRC, kind: "stb", start_time: "12:45:00", end_time: null },
    { id: "e", event_id: SRC, kind: "stage", start_time: "13:00:00", end_time: "13:20:00" },
    { id: "f", event_id: SRC, kind: "booth", start_time: "14:20:00", end_time: "15:50:00" },
    { id: "g", event_id: SRC, kind: "other", start_time: null, end_time: null },
  ],
  setlist_items: [],
  mic_assignments: [],
  event_members: [],
});
const copyRow = (src: Row) => ({
  name: "Next show",
  show_start_time: src.show_start_time,
  hard_out_time: src.hard_out_time,
});

describe("cloneEvent — moving the day to a new stage time", () => {
  it("moves every row, the show start and the hard out by the same amount", async () => {
    const { client, inserted } = fakeDb(realDay());
    const r = await cloneEvent(client, {
      sourceId: SRC,
      sourceLabel: "งานต้นฉบับ",
      buildEvent: copyRow,
      stageStart: "17:30",
    });
    expect(r.shiftedBy).toBe(4.5 * 3600);
    expect(inserted.events[0]).toMatchObject({ show_start_time: "17:30:00", hard_out_time: "17:50:00" });
    const at = Object.fromEntries(
      inserted.schedule_items.map((s) => [s.kind, [s.start_time, s.end_time]])
    );
    expect(at).toEqual({
      on_location: ["15:30:00", null],
      dressing_room: ["15:30:00", null],
      photo: ["16:20:00", null],
      stb: ["17:15:00", null],
      stage: ["17:30:00", "17:50:00"],
      booth: ["18:50:00", "20:20:00"],
      other: [null, null], // a row with no time stays without one
    });
  });

  it("an earlier stage moves the day earlier", async () => {
    const { client, inserted } = fakeDb(realDay());
    const r = await cloneEvent(client, {
      sourceId: SRC,
      sourceLabel: "งานต้นฉบับ",
      buildEvent: copyRow,
      stageStart: "10:45",
    });
    expect(r.shiftedBy).toBe(-(2 * 3600 + 15 * 60));
    expect(inserted.schedule_items.find((s) => s.kind === "on_location")!.start_time).toBe("08:45:00");
  });

  it("no stage time asked for → nothing moves", async () => {
    const { client, inserted } = fakeDb(realDay());
    const r = await cloneEvent(client, { sourceId: SRC, sourceLabel: "งานต้นฉบับ", buildEvent: copyRow });
    expect(r.shiftedBy).toBe(0);
    expect(inserted.schedule_items.find((s) => s.kind === "photo")!.start_time).toBe("11:50:00");
    expect(inserted.events[0]).toMatchObject({ show_start_time: "13:00:00" });
  });

  it("a source with no stage anywhere says it could not move, and moves nothing", async () => {
    const db = realDay();
    db.events[0].show_start_time = null;
    db.schedule_items = db.schedule_items.filter((s) => s.kind !== "stage");
    const { client, inserted } = fakeDb(db);
    const r = await cloneEvent(client, {
      sourceId: SRC,
      sourceLabel: "งานต้นฉบับ",
      buildEvent: copyRow,
      stageStart: "17:30",
    });
    expect(r.shiftedBy).toBeNull();
    expect(inserted.schedule_items.find((s) => s.kind === "photo")!.start_time).toBe("11:50:00");
  });
});

describe("stageAnchorSeconds / shiftClock", () => {
  it("measures from the EARLIEST stage row on a two-stage day, before the show start", () => {
    const rows = [
      { kind: "stage", start_time: "17:40:00" },
      { kind: "stage", start_time: "14:00:00" },
    ];
    expect(stageAnchorSeconds(rows, { show_start_time: "09:00:00" })).toBe(14 * 3600);
    expect(stageAnchorSeconds([], { show_start_time: "09:00:00" })).toBe(9 * 3600);
    expect(stageAnchorSeconds([], { show_start_time: null })).toBeNull();
  });

  it("wraps across midnight and leaves non-times alone", () => {
    expect(shiftClock("23:30:00", 3600)).toBe("00:30:00");
    expect(shiftClock("00:30:00", -3600)).toBe("23:30:00");
    expect(shiftClock(null, 3600)).toBeNull();
    expect(shiftClock("", 3600)).toBe("");
  });
});
