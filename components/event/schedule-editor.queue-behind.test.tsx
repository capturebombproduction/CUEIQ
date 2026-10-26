// Desktop, 2026-10-27: a call-sheet edit made while this event's schedule snapshot is
// STILL WAITING in the offline queue must join that snapshot, not go online.
//
// The venue story: an edit made offline is queued with base = the server's list S0. The
// wifi comes back, but the outbox has not flushed yet (it re-arms every 30 s) and the Ar
// edits another row. That edit used to go ONLINE (server = S0 + e2), so at the flush the
// whole-list fingerprint no longer matched the queued base and the venue edit parked as
// a false conflict "เวอร์ชันออนไลน์ถูกแก้ไขใหม่กว่าของเครื่องนี้" - and resolving it either
// way lost one of the two edits. The setlist builder has joined the queued snapshot since
// c4388cf (lib/mgmt-write.ts tryQueueBehindPendingChildList); the schedule editor now does
// the same before EVERY online write: retype, add, reorder, delete.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
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
import { ScheduleEditor } from "@/components/event/schedule-editor";
import { registerMgmtQueueSink, registerQueuedChildListReader } from "@/lib/mgmt-write";
import { childFlushDecision, type ChildListOp, type NewMgmtOp } from "@/lib/mgmt-outbox";
import type { ScheduleItem } from "@/lib/types";

const EVENT_ID = "eeeeeeee-2222-4222-8222-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-2222-4222-8222-tttttttttttt";
const A = "bbbbbbbb-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "bbbbbbbb-0000-4000-8000-000000000003";

const row = (id: string, sort_order: number, over: Partial<ScheduleItem> = {}): ScheduleItem => ({
  id,
  tenant_id: TENANT_ID,
  event_id: EVENT_ID,
  kind: "other",
  label: null,
  location: null,
  start_time: null,
  end_time: null,
  notes: null,
  sort_order,
  ...over,
});

let supa: SupabaseFake;
let queued: NewMgmtOp[] = [];
let server: ScheduleItem[];
let netDown = false;
/** Every write that reached the (fake) server once the net was back. */
let onlineWrites: string[] = [];

function table(call: RecordedCall) {
  if (netDown) return offline();
  if (call.verb !== "select") onlineWrites.push(call.verb);
  if (call.verb === "update") {
    const r = server.find((x) => x.id === call.eq.id);
    if (!r) return ok([]);
    Object.assign(r, call.values as object);
    return ok([{ id: r.id }]);
  }
  if (call.verb === "delete") {
    const before = server.length;
    server = server.filter((x) => x.id !== call.eq.id);
    return ok(before === server.length ? [] : [{ id: call.eq.id }]);
  }
  if (call.verb === "insert") {
    const r = row("bbbbbbbb-0000-4000-8000-0000000000ff", 99, call.values as Partial<ScheduleItem>);
    server.push(r);
    return ok([{ ...r }]);
  }
  return ok(server.map((r) => ({ ...r })));
}

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  server = [
    row(A, 1, { kind: "on_location", start_time: "14:00:00" }),
    row(B, 2, { kind: "stage", start_time: "18:00:00" }),
    row(C, 3, { kind: "booth", start_time: "19:00:00" }),
  ];
  netDown = false;
  onlineWrites = [];
  supa.setTable("schedule_items", table);
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

function mount() {
  return render(
    <ConfirmProvider>
      <ScheduleEditor
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        eventName="Show"
        editable
        initialItems={server.map((r) => ({ ...r }))}
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

/** The venue edit: row A retyped with the wifi down - queued with base = the server's list. */
async function queueOneOfflineEdit(container: HTMLElement) {
  netDown = true;
  await type(container.querySelector<HTMLInputElement>(`#sc-${A}-label`)!, "ถึงหน้างาน");
  expect(queued, "the offline edit reached the outbox").toHaveLength(1);
  netDown = false; // the net is back; the outbox has not flushed yet
}

const lastRows = () => (queued.at(-1) as ChildListOp).rows as ScheduleItem[];

describe("schedule editor: an edit after the net came back, while a snapshot is still queued", () => {
  it("a retyped row joins the queued snapshot; the flush still applies the venue edit", async () => {
    const { container } = mount();
    await queueOneOfflineEdit(container);
    await type(container.querySelector<HTMLInputElement>(`#sc-${B}-label`)!, "ขึ้นเวที");
    // Online, B would have moved the server under the queued base -> "conflict".
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
    expect(onlineWrites, "no online write on top of a queued snapshot").toEqual([]);
    // both edits ride in the snapshot that will flush, and the tab says it is saved
    const labels = Object.fromEntries(lastRows().map((r) => [r.id, r.label]));
    expect(labels[A]).toBe("ถึงหน้างาน");
    expect(labels[B]).toBe("ขึ้นเวที");
    expect(screen.getByText("บันทึกแล้ว")).toBeTruthy();
  });

  it("add, ▲▼ and delete join it too - nothing goes online", async () => {
    const { container } = mount();
    await queueOneOfflineEdit(container);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /แถวว่าง/ }));
    });
    await waitFor(() => expect(queued).toHaveLength(2));
    expect(lastRows()).toHaveLength(4); // the new row is in the snapshot

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "เลื่อนลง" })[0]);
    });
    await waitFor(() => expect(queued).toHaveLength(3));
    const order = [...lastRows()].sort((x, y) => x.sort_order - y.sort_order).map((r) => r.id);
    expect(order.slice(0, 2)).toEqual([B, A]);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "ลบรายการนี้" })[2]); // row C
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "ลบ" }));
    });
    await waitFor(() => expect(queued).toHaveLength(4));
    expect(lastRows().some((r) => r.id === C)).toBe(false);

    expect(onlineWrites, "every edit joined the queued snapshot").toEqual([]);
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
  });

  it("with nothing queued, an edit still goes online as before", async () => {
    const { container } = mount();
    await type(container.querySelector<HTMLInputElement>(`#sc-${B}-label`)!, "ขึ้นเวที");
    expect(queued).toEqual([]);
    expect(onlineWrites).toEqual(["update"]);
    expect(server.find((r) => r.id === B)!.label).toBe("ขึ้นเวที");
  });
});
