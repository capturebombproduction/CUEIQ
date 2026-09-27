import { describe, it, expect, vi, beforeEach } from "vitest";

const session = vi.hoisted(() => ({ live: true }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => session.live }));

import { cloneEvent } from "./clone-event";

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

    expect(r).toEqual({ newId: "events-new-0", failed: [], attempted: 3 });
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
    expect(r).toEqual({ newId: "events-new-0", failed: [], attempted: 0 });
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
