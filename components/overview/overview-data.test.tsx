import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeSupabaseFake, ok, fail, offline, type SupabaseFake } from "@/test/fakes/supabase";
import { makePerms } from "@/lib/permissions";
import type { Group } from "@/lib/types";
import { loadOverviewData } from "@/components/overview/overview-data";

// The web page's own tests (app/(app)/overview/page*.test.tsx) cover the reads and the
// assembly through the page. These pin the two paths only the DESKTOP board takes -
// before the loader was shared, that page had no behavioural test at all (it was
// checked as text): a failed read handed back instead of thrown, and an unmounted
// page that must not send phase 2.

const GROUP = {
  id: "g1",
  tenant_id: "t1",
  name: "Seishin Kakumei",
  color: "#A62A1C",
  exempt_from_deadline: false,
  self_photo: false,
  contact_name: null,
  contact_phone: null,
  skin: null,
} as unknown as Group;

const EVENT = {
  id: "e1",
  tenant_id: "t1",
  group_id: "g1",
  name: "Sayonara REN",
  event_date: "2026-11-07",
  status: "approved",
  deadline: null,
  notes: null,
  is_template: false,
  is_practice: false,
};

const PHASE_2 = ["schedule_items", "setlist_items", "run_sequence", "mic_assignments", "event_members"];

function fake(): SupabaseFake {
  return makeSupabaseFake({
    script: {
      events: ok([EVENT]),
      members: ok([]),
      songs: ok([]),
      staff_contacts: ok([]),
      schedule_items: ok([]),
      setlist_items: ok([]),
      run_sequence: ok([]),
      mic_assignments: ok([]),
      event_members: ok([]),
    },
  });
}

const load = (supa: SupabaseFake, stillWanted?: () => boolean) =>
  loadOverviewData(supa as unknown as SupabaseClient, {
    tenantId: "t1",
    groups: [GROUP],
    perms: makePerms("admin"),
    stillWanted,
  });

describe("loadOverviewData", () => {
  it("assembles the board when every read succeeds", async () => {
    const res = await load(fake());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.events.map((e) => e.id)).toEqual(["e1"]);
    expect(res.data.bands.map((b) => b.id)).toEqual(["g1"]);
  });

  it("hands a failed phase-1 read back, labelled, and never sends phase 2", async () => {
    const supa = fake();
    supa.setTable("songs", offline());
    const res = await load(supa);
    expect(res).toMatchObject({ ok: false });
    if (res.ok || !("failed" in res)) throw new Error("expected a failed load");
    expect(Object.keys(res.failed)).toEqual(["งาน", "สมาชิกวง", "คลังเพลง", "ทีมงาน"]);
    expect(res.failed["คลังเพลง"].error).toBeTruthy();
    for (const t of PHASE_2) expect(supa.callsTo(t)).toHaveLength(0);
  });

  it("hands a failed phase-2 read back, labelled", async () => {
    const supa = fake();
    supa.setTable("setlist_items", fail("boom-setlist", 500));
    const res = await load(supa);
    if (res.ok || !("failed" in res)) throw new Error("expected a failed load");
    expect(Object.keys(res.failed)).toEqual([
      "รันดาวน์",
      "เซ็ตลิสต์",
      "ลำดับคิวงาน",
      "ผังไมค์",
      "รายชื่อคนมา",
    ]);
    expect(res.failed["เซ็ตลิสต์"].error?.message).toContain("boom-setlist");
  });

  it("stops after phase 1 when the caller no longer wants the result (desktop unmount)", async () => {
    const supa = fake();
    const res = await load(supa, () => false);
    expect(res).toEqual({ ok: false, abandoned: true });
    for (const t of PHASE_2) expect(supa.callsTo(t)).toHaveLength(0);
  });

  it("a failed phase 1 wins over an unmount — the same order the desktop page had", async () => {
    const supa = fake();
    supa.setTable("events", fail("boom-events", 500));
    const res = await load(supa, () => false);
    expect("failed" in res).toBe(true);
  });
});
