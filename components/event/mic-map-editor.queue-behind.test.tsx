// Desktop, 2026-10-27: a Mic Map edit made while this event's mic snapshot is STILL
// WAITING in the offline queue must join that snapshot, not go online.
//
// An edit made offline is queued with base = the server's map M0. The wifi comes back,
// the outbox has not flushed yet (30 s re-arm), and the next edit used to go ONLINE
// (server = M0 + e2): at the flush the fingerprint no longer matched the queued base and
// the venue edit parked as a false conflict "เวอร์ชันออนไลน์ถูกแก้ไขใหม่กว่าของเครื่องนี้" -
// resolving it either way lost one of the two edits. The setlist builder has joined the
// queued snapshot since c4388cf (lib/mgmt-write.ts tryQueueBehindPendingChildList); the
// Mic Map now checks first at EVERY write: a holder's name, เพิ่มไมค์ (and its first-add
// seed from the members' standing mics), เพิ่มคน, ▲▼ (both the swap and the renumber of a
// group with duplicate order), a mic's number, เอาออก and ลบไมค์.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor, within } from "@testing-library/react";
import {
  makeSupabaseFake,
  makeSession,
  ok,
  offline,
  type RecordedCall,
  type SupabaseFake,
} from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { MicMapEditor } from "@/components/event/mic-map-editor";
import { registerMgmtQueueSink, registerQueuedChildListReader } from "@/lib/mgmt-write";
import { childFlushDecision, type ChildListOp, type NewMgmtOp } from "@/lib/mgmt-outbox";
import type { Member, MicAssignment } from "@/lib/types";

const EVENT_ID = "eeeeeeee-3333-4333-8333-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-3333-4333-8333-tttttttttttt";
const A = "cccccccc-0000-4000-8000-000000000001";
const B = "cccccccc-0000-4000-8000-000000000002";
const D1 = "cccccccc-0000-4000-8000-000000000031";
const D2 = "cccccccc-0000-4000-8000-000000000032";
const E1 = "cccccccc-0000-4000-8000-000000000041";
const E2 = "cccccccc-0000-4000-8000-000000000042";

const mic = (id: string, mic_number: number, holder_name: string, order_index = 1): MicAssignment => ({
  id,
  tenant_id: TENANT_ID,
  event_id: EVENT_ID,
  mic_number,
  holder_name,
  order_index,
  created_at: "2026-10-26T00:00:00Z",
});

const member = (n: number): Member => ({
  id: `dddddddd-0000-4000-8000-00000000000${n}`,
  tenant_id: TENANT_ID,
  group_id: "g1",
  name: `สมาชิก ${n}`,
  nickname: `นิค${n}`,
  mic_number: n,
  color: null,
  sort_order: n,
  created_at: "2026-01-01T00:00:00.000Z",
});

let supa: SupabaseFake;
let queued: NewMgmtOp[] = [];
let server: MicAssignment[];
let netDown = false;
/** Every write that reached the (fake) server once the net was back. */
let onlineWrites: string[] = [];

const matches = (x: MicAssignment, eq: Record<string, unknown>) =>
  Object.entries(eq).every(([k, v]) => (x as unknown as Record<string, unknown>)[k] === v);

function table(call: RecordedCall) {
  if (netDown) return offline();
  if (call.verb !== "select") onlineWrites.push(call.verb);
  if (call.verb === "update") {
    const hit = server.filter((x) => matches(x, call.eq));
    for (const r of hit) Object.assign(r, call.values as object);
    return ok(hit.map((r) => ({ id: r.id })));
  }
  if (call.verb === "delete") {
    const hit = server.filter((x) => matches(x, call.eq));
    server = server.filter((x) => !hit.includes(x));
    return ok(hit.map((r) => ({ id: r.id })));
  }
  if (call.verb === "insert") {
    const values = ([] as Partial<MicAssignment>[]).concat(call.values as Partial<MicAssignment>);
    const rows = values.map((v, i) => ({ ...mic(`cccccccc-0000-4000-8000-0000000009${i}0`, 0, ""), ...v }));
    server.push(...rows);
    return ok(rows.map((r) => ({ ...r })));
  }
  return ok(server.map((r) => ({ ...r })));
}

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  server = [
    mic(A, 1, "Ren"),
    mic(B, 2, "Mio"),
    // a shared mic whose two holders carry the SAME order (added from two devices)
    mic(D1, 3, "Ai"),
    mic(D2, 3, "Yu"),
    // a shared mic in rotation order
    mic(E1, 4, "Kei", 1),
    mic(E2, 4, "Sho", 2),
  ];
  netDown = false;
  onlineWrites = [];
  supa.setTable("mic_assignments", table);
  queued = [];
  registerMgmtQueueSink(async (op) => {
    queued.push(op);
  });
  // the desktop's reader (desktop/src/main.tsx): is a snapshot of this list still queued?
  registerQueuedChildListReader(async (kind, eventId) =>
    queued.some((op) => op.kind === kind && (op as ChildListOp).id === eventId)
  );
});
afterEach(() => {
  registerMgmtQueueSink(null);
  registerQueuedChildListReader(null);
  cleanup();
});

function mount(initialMics: MicAssignment[] = server, members: Member[] = []) {
  return render(
    <ConfirmProvider>
      <MicMapEditor
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        eventName="Show"
        editable
        initialMics={initialMics.map((r) => ({ ...r }))}
        members={members}
        setlist={[]}
      />
    </ConfirmProvider>
  );
}

async function type(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } });
  await act(async () => {
    fireEvent.blur(el);
  });
}
async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}
/** The ▼ on the row of the holder whose name field has this label. */
const moveDown = (holderLabel: string) =>
  within(screen.getByLabelText(holderLabel).parentElement!).getByRole("button", { name: "เลื่อนลง" });
async function confirmYes() {
  await click(await screen.findByRole("button", { name: "ลบ" }));
}

/** The venue edit: mic 1's holder renamed with the wifi down - queued with base = M0. */
async function queueOneOfflineEdit() {
  netDown = true;
  await type(screen.getByLabelText("ผู้ถือไมค์ 1"), "Ren (กีตาร์)");
  expect(queued, "the offline edit reached the outbox").toHaveLength(1);
  netDown = false; // the net is back; the outbox has not flushed yet
}

const lastRows = () => (queued.at(-1) as ChildListOp).rows as MicAssignment[];
const orderOf = (id: string) => lastRows().find((r) => r.id === id)!.order_index;

describe("mic map: an edit after the net came back, while a snapshot is still queued", () => {
  it("a renamed holder joins the queued snapshot; the flush still applies the venue edit", async () => {
    mount();
    await queueOneOfflineEdit();
    await type(screen.getByLabelText("ผู้ถือไมค์ 2"), "Mio (ร้องนำ)");
    // Online, mic 2 would have moved the server under the queued base -> "conflict".
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
    expect(onlineWrites, "no online write on top of a queued snapshot").toEqual([]);
    const names = lastRows().map((r) => r.holder_name);
    expect(names).toContain("Ren (กีตาร์)");
    expect(names).toContain("Mio (ร้องนำ)");
    expect(screen.getByText("บันทึกแล้ว")).toBeTruthy();
  });

  it("เพิ่มไมค์, เพิ่มคน, ▲▼, a new number, เอาออก and ลบไมค์ join it too - nothing goes online", async () => {
    mount();
    await queueOneOfflineEdit();
    let joins = 1;
    const joined = async () => {
      joins += 1;
      await waitFor(() => expect(queued).toHaveLength(joins));
    };

    await click(screen.getByRole("button", { name: /เพิ่มไมค์/ })); // addMic
    await joined();
    expect(lastRows().some((r) => r.mic_number === 5)).toBe(true);

    await click(screen.getAllByRole("button", { name: /เพิ่มคน/ })[1]); // addHolder on mic 2
    await joined();
    expect(lastRows().filter((r) => r.mic_number === 2)).toHaveLength(2);

    // ▲▼ on mic 4 (orders 1 / 2): the plain swap
    await click(moveDown("ผู้ถือไมค์ 4 คนที่ 1"));
    await joined();
    expect([orderOf(E1), orderOf(E2)]).toEqual([2, 1]);
    // ▲▼ on mic 3 (both order 1): the renumber branch
    await click(moveDown("ผู้ถือไมค์ 3 คนที่ 1"));
    await joined();
    expect([orderOf(D1), orderOf(D2)]).toEqual([2, 1]);

    // mic 1 becomes mic 9
    const num = screen.getByRole("spinbutton", { name: "หมายเลขไมค์ 1" }) as HTMLInputElement;
    fireEvent.change(num, { target: { value: "9" } });
    await act(async () => {
      fireEvent.blur(num);
    });
    await joined();
    expect(lastRows().find((r) => r.id === A)!.mic_number).toBe(9);

    await click(screen.getByRole("button", { name: "เอา Kei ออกจากไมค์ 4" })); // removeHolder
    await confirmYes();
    await joined();
    expect(lastRows().some((r) => r.id === E1)).toBe(false);

    await click(screen.getByRole("button", { name: "ลบไมค์ 3" })); // removeMic
    await confirmYes();
    await joined();
    expect(lastRows().some((r) => r.mic_number === 3)).toBe(false);

    expect(onlineWrites, "every edit joined the queued snapshot").toEqual([]);
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
  });

  it("the first เพิ่มไมค์ on the members' standing mics (the seed) joins it too", async () => {
    // a snapshot of this event's mics already waits in the queue (an earlier offline edit)
    queued.push({
      kind: "mic.upsert",
      id: EVENT_ID,
      tenantId: TENANT_ID,
      eventName: "Show",
      rows: [],
      base: null,
    } as unknown as NewMgmtOp);
    mount([], [member(1), member(2)]);
    await click(screen.getByRole("button", { name: /เพิ่มไมค์/ }));
    await waitFor(() => expect(queued).toHaveLength(2));
    expect(onlineWrites).toEqual([]);
    // the standing mics 1 and 2, then the new empty mic 3
    expect(lastRows().map((r) => r.mic_number).sort()).toEqual([1, 2, 3]);
  });

  it("with nothing queued, an edit still goes online as before", async () => {
    mount();
    await type(screen.getByLabelText("ผู้ถือไมค์ 2"), "Mio (ร้องนำ)");
    expect(queued).toEqual([]);
    expect(onlineWrites).toEqual(["update"]);
    expect(server.find((r) => r.id === B)!.holder_name).toBe("Mio (ร้องนำ)");
  });
});
