// A copy of a show leaves out the members who have left the band (0054).
//
// 2026-10-27, hunt 8: "ก๊อปงาน" and "สร้างจากแม่แบบ" copied the source's lineup as it was.
// Duplicating last week's show after a member left put them on the new show, and a lineup
// that holds a member keeps them on that show (lib/member-status.ts membersForShow) - its
// Lineup, gate, sheets, Live and share page - after the Artists screen had said they would
// not show on new shows. Their Mic Map rows came along too.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));

import { cloneEvent } from "./clone-event";
import { membersForShow } from "./member-status";

type Row = Record<string, unknown>;

/** Just enough of the query builder for cloneEvent (as clone-event.test.ts). */
function fakeDb(db: Record<string, Row[]>, { failRead = [] as string[] } = {}) {
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

// bell left on 2026-10-27 (Bangkok); the source show, 2026-10-20, had aya and bell
const MEMBERS: Row[] = [
  { id: "aya", group_id: "g1", name: "Aya", nickname: "Aya", left_at: null },
  { id: "bell", group_id: "g1", name: "Bell", nickname: "Bell", left_at: "2026-10-27T09:00:00Z" },
];
const source = (members: Row[] = MEMBERS): Record<string, Row[]> => ({
  events: [{ id: "src", tenant_id: "t1", group_id: "g1", name: "Last week", event_date: "2026-10-20" }],
  schedule_items: [],
  setlist_items: [],
  mic_assignments: [
    { id: "a1", event_id: "src", tenant_id: "t1", mic_number: 1, holder_name: "Aya", order_index: 1 },
    { id: "a2", event_id: "src", tenant_id: "t1", mic_number: 2, holder_name: "Bell", order_index: 1 },
  ],
  event_members: [
    { id: "e1", event_id: "src", tenant_id: "t1", member_id: "aya" },
    { id: "e2", event_id: "src", tenant_id: "t1", member_id: "bell" },
  ],
  members,
});
const copyDated = (event_date: string | null) => (s: Row) => ({
  tenant_id: s.tenant_id,
  group_id: s.group_id,
  name: "Copy",
  event_date,
});
const lineupOf = (inserted: Record<string, Row[]>) => (inserted.event_members ?? []).map((r) => r.member_id);
const holdersOf = (inserted: Record<string, Row[]>) => (inserted.mic_assignments ?? []).map((r) => r.holder_name);

describe("cloneEvent: members who have left the band", () => {
  it("a copy dated after the leaving day leaves them out of the lineup and the Mic Map", async () => {
    const { client, inserted } = fakeDb(source());
    await cloneEvent(client, { sourceId: "src", sourceLabel: "งานต้นฉบับ", buildEvent: copyDated("2026-11-03") });
    expect(lineupOf(inserted)).toEqual(["aya"]);
    expect(holdersOf(inserted)).toEqual(["Aya"]);
    const shown = membersForShow(MEMBERS as never[], { eventDate: "2026-11-03", lineup: lineupOf(inserted) as string[] });
    expect(shown.map((m: { id: string }) => m.id)).toEqual(["aya"]);
  });

  it("a copy dated on or before the leaving day keeps them (they were still in the band)", async () => {
    const { client, inserted } = fakeDb(source());
    await cloneEvent(client, { sourceId: "src", sourceLabel: "งานต้นฉบับ", buildEvent: copyDated("2026-10-27") });
    expect(lineupOf(inserted)).toEqual(["aya", "bell"]);
    expect(holdersOf(inserted)).toEqual(["Aya", "Bell"]);
  });

  it("an undated copy (a template's) leaves them out", async () => {
    const { client, inserted } = fakeDb(source());
    await cloneEvent(client, { sourceId: "src", sourceLabel: "แม่แบบ", buildEvent: copyDated(null) });
    expect(lineupOf(inserted)).toEqual(["aya"]);
  });

  it("keeps a Mic Map row whose name a member still in the band answers to", async () => {
    const members = [MEMBERS[0], { ...MEMBERS[1], nickname: "Aya" }];
    const { client, inserted } = fakeDb(source(members));
    await cloneEvent(client, { sourceId: "src", sourceLabel: "งานต้นฉบับ", buildEvent: copyDated("2026-11-03") });
    expect(lineupOf(inserted)).toEqual(["aya"]);
    expect(holdersOf(inserted)).toEqual(["Aya"]);
  });

  it("a members read that failed creates nothing, like every other read", async () => {
    const { client, inserted } = fakeDb(source(), { failRead: ["members"] });
    await expect(
      cloneEvent(client, { sourceId: "src", sourceLabel: "งานต้นฉบับ", buildEvent: copyDated("2026-11-03") })
    ).rejects.toThrow(/สมาชิกวง.*ยังไม่ได้สร้างงานใหม่/);
    expect(inserted.events).toBeUndefined();
  });
});
