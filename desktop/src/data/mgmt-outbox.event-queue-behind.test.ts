// Hunt 3 (2026-10-27), events-4: the event form had no "queue-behind". An edit queued offline
// (venue) and a second edit saved ONLINE before the outbox flushed (30 s re-arm) make the
// flush see the row's updated_at past the queued base - a false "เวอร์ชันออนไลน์ถูกแก้ไข
// ใหม่กว่าของเครื่องนี้" for an event nobody else touched. The four child editors join a
// still-queued snapshot since 19ea761/17b15ef; saveEventWrite does not.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  makeSession,
  makeSupabaseFake,
  ok,
  offline,
  type RecordedCall,
  type SupabaseFake,
} from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { registerMgmtQueueSink, registerQueuedEventOpReader, saveEventWrite } from "@/lib/mgmt-write";
import {
  clearMgmtOutbox,
  enqueueMgmtOp,
  flushMgmtOutbox,
  listMgmtConflicts,
  pendingMgmtOps,
} from "~/data/mgmt-outbox";

const EVENT_ID = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
const T0 = "2026-10-27T10:00:00.000Z";

let supa: SupabaseFake;
let row: Record<string, unknown>;
let netDown = false;
let clock = Date.parse(T0);

beforeEach(async () => {
  row = {
    id: EVENT_ID,
    tenant_id: "t1",
    name: "Seishin @ venue",
    venue: "Old hall",
    show_start_time: "17:00:00",
    status: "draft",
    updated_at: T0,
  };
  netDown = false;
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  supa.setTable("events", (call: RecordedCall) => {
    if (netDown) return offline();
    if (call.verb === "update") {
      clock += 60_000;
      Object.assign(row, call.values as object, { updated_at: new Date(clock).toISOString() });
      return ok([{ id: EVENT_ID, updated_at: row.updated_at }]);
    }
    return ok(call.terminal ? { ...row } : [{ ...row }]);
  });
  await clearMgmtOutbox();
  registerMgmtQueueSink(enqueueMgmtOp);
  // what desktop/src/main.tsx registers
  registerQueuedEventOpReader(async (eventId) =>
    (await pendingMgmtOps()).some(
      (op) => (op.kind === "event.update" || op.kind === "event.create") && op.id === eventId
    )
  );
});
afterEach(() => {
  registerMgmtQueueSink(null);
  registerQueuedEventOpReader(null);
});

describe("event form: an online edit while an offline one is still queued", () => {
  it("the flush lands the queued edit instead of parking a false conflict", async () => {
    // at the venue, wifi down: venue fixed, queued
    netDown = true;
    const a = await saveEventWrite({
      mode: "edit",
      payload: { tenant_id: "t1", venue: "New hall" },
      eventId: EVENT_ID,
      baseUpdatedAt: T0,
    });
    expect(a).toMatchObject({ ok: true, queued: true });

    // wifi back, outbox not flushed yet: the show start moved, saved online
    netDown = false;
    const b = await saveEventWrite({
      mode: "edit",
      payload: { tenant_id: "t1", show_start_time: "18:00" },
      eventId: EVENT_ID,
      baseUpdatedAt: T0,
    });
    // joined the queued edit instead of writing over its base
    expect(b).toMatchObject({ ok: true, queued: true, behind: true });

    const res = await flushMgmtOutbox();
    expect(await listMgmtConflicts()).toHaveLength(0);
    expect(res.parked).toBe(0);
    expect(row.venue).toBe("New hall");
    expect(row.show_start_time).toBe("18:00");
  });
});
