// A call-sheet row whose insert ANSWER is lost (2026-10-30, hunt 11). On venue Wi-Fi the insert
// can land while its reply dies on the way back (status 0, "TypeError: Failed to fetch"): the
// editor said "Failed to add item", the row was not on screen, and the retap put a second one on
// the sheet. The insert now carries its minted id and a reply-less failure reads it back; the
// offline queue holds the SAME row. A write with a real HTTP answer is judged as before.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import {
  makeSupabaseFake,
  makeSession,
  ok,
  fail,
  offline,
  type SupabaseFake,
  type RecordedCall,
} from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { toast } from "sonner";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ScheduleEditor } from "@/components/event/schedule-editor";
import { registerMgmtQueueSink } from "@/lib/mgmt-write";
import { childFlushDecision, type ChildListOp, type NewMgmtOp } from "@/lib/mgmt-outbox";
import type { ScheduleItem } from "@/lib/types";

const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-1111-4111-8111-tttttttttttt";

let supa: SupabaseFake;
let db: ScheduleItem[];
let insertAnswer: ReturnType<typeof ok> | null;
let insertLands: boolean;
let readsDown: boolean;

function table(call: RecordedCall) {
  if (call.verb === "insert") {
    const values = call.values as Partial<ScheduleItem>;
    const row: ScheduleItem = {
      id: values.id ?? "server-minted",
      tenant_id: TENANT_ID,
      event_id: EVENT_ID,
      kind: "other",
      label: null,
      location: null,
      start_time: null,
      end_time: null,
      notes: null,
      sort_order: 0,
      ...values,
    };
    if (insertLands) db.push(row);
    return insertAnswer ?? ok(row);
  }
  if (readsDown) return offline();
  return ok(db.filter((r) => call.eq.id === undefined || r.id === call.eq.id));
}

const rowsOnScreen = () => screen.queryAllByRole("button", { name: "เลื่อนขึ้น" }).length;
const readBacks = () =>
  supa.callsTo("schedule_items", "select").filter((c) => c.eq.id !== undefined);

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  db = [];
  insertAnswer = null;
  insertLands = true;
  readsDown = false;
  supa.setTable("schedule_items", table);
});
afterEach(() => {
  registerMgmtQueueSink(null);
  cleanup();
});

function mount() {
  return render(
    <ConfirmProvider>
      <ScheduleEditor eventId={EVENT_ID} tenantId={TENANT_ID} eventName="Show" editable initialItems={[]} />
    </ConfirmProvider>
  );
}

async function addPhoto() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /ถ่ายรูป/ }));
  });
}

describe("ScheduleEditor: a row whose insert answer was lost", () => {
  it("landed: the row is on the sheet once and no failure is reported", async () => {
    insertAnswer = offline();
    mount();
    await addPhoto();
    await waitFor(() => expect(rowsOnScreen()).toBe(1));
    expect(db).toHaveLength(1);
    expect(db[0].id).toBe((supa.callsTo("schedule_items", "insert")[0].values as { id: string }).id);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("not landed: today's failure, unchanged (web)", async () => {
    insertAnswer = offline();
    insertLands = false;
    mount();
    await addPhoto();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to add item", expect.anything()));
    expect(readBacks()).toHaveLength(1);
    expect(rowsOnScreen()).toBe(0);
  });

  it("a real HTTP answer is believed as before: no read-back", async () => {
    insertAnswer = fail("Service Unavailable", 503);
    insertLands = false;
    mount();
    await addPhoto();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to add item", expect.anything()));
    expect(readBacks()).toHaveLength(0);
  });

  it("desktop, read-back impossible too: the queued row IS the row that landed", async () => {
    const queued: NewMgmtOp[] = [];
    registerMgmtQueueSink(async (op) => {
      queued.push(op);
    });
    insertAnswer = offline();
    supa.setTable("schedule_items", (call) => {
      const r = table(call);
      if (call.verb === "insert") readsDown = true;
      return r;
    });
    mount();
    await addPhoto();
    await waitFor(() => expect(queued).toHaveLength(1));
    const op = queued[0] as ChildListOp;
    expect((op.rows as ScheduleItem[]).map((r) => r.id)).toEqual(db.map((r) => r.id));
    expect(childFlushDecision(op, db)).toBe("already-applied");
  });
});
