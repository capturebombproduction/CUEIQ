// The Mics tab's first เพิ่มไมค์ whose insert ANSWER is lost (2026-10-30, hunt 11). The seed is
// one insert of every standing mic plus the new one; on venue Wi-Fi it could land while its reply
// died on the way back (status 0, "TypeError: Failed to fetch"). The tab said "เพิ่มไมค์ไม่สำเร็จ"
// and kept showing the standing mics, so the retap seeded them all AGAIN - and per-event rows are
// what the Summary, the readiness gate and the Excel sheet print. The rows now carry their minted
// ids and a reply-less failure reads them back; the offline queue holds the SAME rows.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeSession, makeSupabaseFake, ok, fail, offline, type RecordedCall } from "@/test/fakes/supabase";
import type { SupabaseFake } from "@/test/fakes/supabase";
import type { Member, MicAssignment } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { MicMapEditor } from "@/components/event/mic-map-editor";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { registerMgmtQueueSink } from "@/lib/mgmt-write";
import { childFlushDecision, type ChildListOp, type NewMgmtOp } from "@/lib/mgmt-outbox";

const ADD = /เพิ่มไมค์/;
const member = (n: number): Member => ({
  id: `m${n}`,
  tenant_id: "t1",
  group_id: "g1",
  name: `สมาชิก ${n}`,
  nickname: `นิค${n}`,
  mic_number: n,
  color: null,
  sort_order: n,
  created_at: "2026-01-01T00:00:00.000Z",
});

let supa: SupabaseFake;
let db: MicAssignment[];
let insertAnswer: ReturnType<typeof ok> | null;
let insertLands: boolean;
let readsDown: boolean;

function table(call: RecordedCall) {
  if (call.verb === "insert") {
    const rows = (Array.isArray(call.values) ? call.values : [call.values]) as Omit<MicAssignment, "created_at">[];
    const landed: MicAssignment[] = rows.map((r) => ({ created_at: "2026-10-30T00:00:00.000Z", ...r }));
    if (insertLands) db.push(...landed);
    if (insertAnswer) return insertAnswer;
    return ok(call.terminal === "single" ? landed[0] : landed);
  }
  if (readsDown) return offline();
  const byId = call.filters.find((f) => f.op === "in" && f.column === "id");
  return ok(byId ? db.filter((r) => (byId.value as string[]).includes(r.id)) : db);
}

const micInputs = () =>
  screen.queryAllByRole("spinbutton").map((el) => Number((el as HTMLInputElement).value));
const readBacks = () =>
  supa.callsTo("mic_assignments", "select").filter((c) => c.filters.some((f) => f.op === "in"));

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  db = [];
  insertAnswer = null;
  insertLands = true;
  readsDown = false;
  supa.setTable("mic_assignments", table);
  toast.error.mockClear();
});
afterEach(() => {
  registerMgmtQueueSink(null);
  document.body.innerHTML = "";
});

function mount() {
  return render(
    <ConfirmProvider>
      <MicMapEditor
        eventId="e1"
        tenantId="t1"
        editable
        initialMics={[]}
        members={[1, 2, 3].map(member)}
        lineup={[]}
        setlist={[]}
        eventName="งานทดสอบ"
      />
    </ConfirmProvider>
  );
}

describe("MicMapEditor · a seed whose insert answer was lost", () => {
  it("landed: the show's map shows once, no failure, nothing to retap", async () => {
    insertAnswer = offline();
    mount();
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(micInputs()).toEqual([1, 2, 3, 4]));
    expect(db).toHaveLength(4);
    expect(toast.error).not.toHaveBeenCalled();
    // the screen holds the server's rows, by the ids the insert carried
    const sent = (supa.callsTo("mic_assignments", "insert")[0].values as { id: string }[]).map((r) => r.id);
    expect(db.map((r) => r.id)).toEqual(sent);
  });

  it("not landed: today's failure, the standing mics still showing", async () => {
    insertAnswer = offline();
    insertLands = false;
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("เพิ่มไมค์ไม่สำเร็จ", expect.anything()));
    expect(readBacks()).toHaveLength(1);
    expect(container.querySelectorAll(".mic")).toHaveLength(3);
  });

  it("a real HTTP answer is believed as before: no read-back", async () => {
    insertAnswer = fail("Service Unavailable", 503);
    insertLands = false;
    mount();
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("เพิ่มไมค์ไม่สำเร็จ", expect.anything()));
    expect(readBacks()).toHaveLength(0);
  });

  it("desktop, read-back impossible too: the queued rows ARE the rows that landed", async () => {
    const queued: NewMgmtOp[] = [];
    registerMgmtQueueSink(async (op) => {
      queued.push(op);
    });
    insertAnswer = offline();
    supa.setTable("mic_assignments", (call) => {
      const r = table(call);
      if (call.verb === "insert") readsDown = true;
      return r;
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: ADD }));
    await waitFor(() => expect(queued).toHaveLength(1));
    const op = queued[0] as ChildListOp;
    expect((op.rows as MicAssignment[]).map((r) => r.id)).toEqual(db.map((r) => r.id));
    expect(childFlushDecision(op, db)).toBe("already-applied");
  });
});
