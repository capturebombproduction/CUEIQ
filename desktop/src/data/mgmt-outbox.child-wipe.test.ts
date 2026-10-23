import { describe, it, expect, vi, beforeEach } from "vitest";
import { fail, makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

// 2026-10-24 review (Argon, verified): a schedule snapshot queued offline can itself break
// the photo-round key (mig 0042: one ถ่ายรูป round per event per NAME, an unnamed one
// counting as "ถ่ายรูป") - offline nothing asks the server, so two unnamed photo rows go
// into the queue. On reconnect the replay's collision path then wiped EVERY schedule row
// of the event and re-inserted the snapshot, which failed on the same key: every phone
// saw an empty schedule, and the conflict asked them to fix it "on the online version",
// which no longer existed. Such a snapshot must park before it writes anything.

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { clearMgmtOutbox, enqueueMgmtOp, flushMgmtOutbox, listMgmtConflicts } from "./mgmt-outbox";

const EVENT_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const TENANT_ID = "cccccccc-3333-4333-8333-cccccccccccc";

const row = (id: string, kind: string, label: string | null, sort: number) => ({
  id,
  tenant_id: TENANT_ID,
  event_id: EVENT_ID,
  kind,
  label,
  location: null,
  start_time: "10:00",
  end_time: null,
  notes: null,
  sort_order: sort,
});

const SERVER = [row("aaaaaaaa-0000-4000-8000-000000000001", "on_location", "ถึงหน้างาน", 1)];
const DUP = { code: "23505", message: 'duplicate key value violates unique constraint "schedule_items_photo_round_per_event"' };

let supa: SupabaseFake;

beforeEach(async () => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  await clearMgmtOutbox();
});

describe("flushMgmtOutbox — a schedule snapshot that breaks the photo-round key", () => {
  it("parks it and leaves the server's rows alone - no wipe, no write", async () => {
    // deletes go through, as they would: only the writes that carry the snapshot collide
    supa.setScript({
      schedule_items: (call) =>
        call.verb === "select" ? ok(SERVER) : call.verb === "delete" ? ok([]) : fail(DUP, 409),
    });
    await enqueueMgmtOp({
      kind: "schedule.upsert",
      id: EVENT_ID,
      tenantId: TENANT_ID,
      base: null,
      rows: [
        ...SERVER,
        row("aaaaaaaa-0000-4000-8000-000000000002", "photo", null, 2),
        row("aaaaaaaa-0000-4000-8000-000000000003", "photo", " ถ่ายรูป ", 3),
      ],
    });

    const res = await flushMgmtOutbox();

    expect(res).toMatchObject({ flushed: 0, parked: 1 });
    const writes = supa.calls.filter((c) => c.table === "schedule_items" && c.verb !== "select");
    expect(writes).toEqual([]);
    const conflicts = await listMgmtConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].rec.reason).toMatch(/ซ้ำ/);
  });

  it("two photo rounds with different names are a valid snapshot and still go out", async () => {
    supa.setScript({ schedule_items: (call) => (call.verb === "select" ? ok(SERVER) : ok([])) });
    await enqueueMgmtOp({
      kind: "schedule.upsert",
      id: EVENT_ID,
      tenantId: TENANT_ID,
      base: null,
      rows: [
        ...SERVER,
        row("aaaaaaaa-0000-4000-8000-000000000002", "photo", "ชุด 1", 2),
        row("aaaaaaaa-0000-4000-8000-000000000003", "photo", "ชุด 2", 3),
      ],
    });

    const res = await flushMgmtOutbox();

    expect(res).toMatchObject({ flushed: 1, parked: 0 });
    expect(supa.calls.some((c) => c.table === "schedule_items" && c.verb === "upsert")).toBe(true);
  });
});
