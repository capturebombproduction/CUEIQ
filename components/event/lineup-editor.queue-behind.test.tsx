// Desktop, 2026-10-27: a Lineup edit made while this event's lineup snapshot is STILL
// WAITING in the offline queue must join that snapshot, not go online.
//
// A member taken off offline is queued with base = the server's set S0. The wifi comes
// back, the outbox has not flushed yet (30 s re-arm), and the next tap used to go ONLINE
// (server = S0 + e2): at the flush the set no longer matched the queued base and the
// venue edit parked as a false conflict "เวอร์ชันออนไลน์ถูกแก้ไขใหม่กว่าของเครื่องนี้" -
// resolving it either way lost one of the two edits. The setlist builder has joined the
// queued snapshot since c4388cf (lib/mgmt-write.ts tryQueueBehindPendingChildList); every
// Lineup write (a tap, เลือกทั้งหมด, ล้าง) now checks first, with the set the server last
// acknowledged as the base.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  makeSupabaseFake,
  makeSession,
  ok,
  offline,
  type RecordedCall,
  type SupabaseFake,
} from "@/test/fakes/supabase";
import type { Member } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { LineupEditor } from "@/components/event/lineup-editor";
import { registerMgmtQueueSink, registerQueuedChildListReader } from "@/lib/mgmt-write";
import { childFlushDecision, type ChildListOp, type NewMgmtOp } from "@/lib/mgmt-outbox";
import { resetDirtyGuard, unsavedWork } from "@/lib/dirty-guard";

const EVENT_ID = "eeeeeeee-4444-4444-8444-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-4444-4444-8444-tttttttttttt";

const member = (n: number): Member => ({
  id: `m${n}`,
  tenant_id: TENANT_ID,
  group_id: "g1",
  name: `สมาชิก ${n}`,
  nickname: `นิค${n}`,
  mic_number: n,
  color: null,
  sort_order: n,
  created_at: "2026-01-01T00:00:00.000Z",
});
const MEMBERS = [1, 2, 3].map(member);

let supa: SupabaseFake;
let queued: NewMgmtOp[] = [];
/** event_members on the server, as member ids */
let server: string[];
let netDown = false;
/** Every write that reached the (fake) server once the net was back. */
let onlineWrites: string[] = [];

function table(call: RecordedCall) {
  if (netDown) return offline();
  if (call.verb !== "select") onlineWrites.push(call.verb);
  if (call.verb === "delete") {
    const hit = server.filter((id) => call.eq.member_id === undefined || id === call.eq.member_id);
    server = server.filter((id) => !hit.includes(id));
    return ok(hit.map((member_id) => ({ member_id })));
  }
  if (call.verb === "insert" || call.verb === "upsert") {
    const values = ([] as { member_id: string }[]).concat(call.values as { member_id: string });
    const added = values.map((v) => v.member_id).filter((id) => !server.includes(id));
    server.push(...added);
    return ok(added.map((member_id) => ({ member_id })));
  }
  return ok(server.map((member_id) => ({ member_id })));
}

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  server = ["m1", "m2", "m3"];
  netDown = false;
  onlineWrites = [];
  supa.setTable("event_members", table);
  queued = [];
  registerMgmtQueueSink(async (op) => {
    queued.push(op);
  });
  // the desktop's reader (desktop/src/main.tsx): is a snapshot of this list still queued?
  registerQueuedChildListReader(async (kind, eventId) =>
    queued.some((op) => op.kind === kind && (op as ChildListOp).id === eventId)
  );
  resetDirtyGuard();
});
afterEach(() => {
  registerMgmtQueueSink(null);
  registerQueuedChildListReader(null);
  resetDirtyGuard();
  cleanup();
});

function mount() {
  return render(
    <ConfirmProvider>
      <LineupEditor
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        eventName="Show"
        editable
        members={MEMBERS}
        initialLineup={[...server]}
      />
    </ConfirmProvider>
  );
}

const tap = (nick: string) => userEvent.click(screen.getByRole("button", { name: new RegExp(nick) }));
const lastRows = () => [...((queued.at(-1) as ChildListOp).rows as string[])].sort();

/** The venue edit: นิค2 taken off with the wifi down - queued with base = the server's set. */
async function queueOneOfflineEdit() {
  netDown = true;
  await tap("นิค2");
  await waitFor(() => expect(queued, "the offline edit reached the outbox").toHaveLength(1));
  netDown = false; // the net is back; the outbox has not flushed yet
}

describe("lineup: an edit after the net came back, while a snapshot is still queued", () => {
  it("a tap joins the queued snapshot; the flush still applies the venue edit", async () => {
    mount();
    await queueOneOfflineEdit();
    await tap("นิค3");
    await waitFor(() => expect(queued).toHaveLength(2));
    // Online, นิค3's delete would have moved the server under the queued base -> "conflict".
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
    expect(onlineWrites, "no online write on top of a queued snapshot").toEqual([]);
    expect(lastRows()).toEqual(["m1"]);
    await waitFor(() => expect(unsavedWork().pending).toBe(0));
    expect(screen.getByText("บันทึกแล้ว")).toBeTruthy();
  });

  it("เลือกทั้งหมด and ล้าง join it too - nothing goes online", async () => {
    mount();
    await queueOneOfflineEdit();

    await userEvent.click(screen.getByRole("button", { name: /เลือกทั้งหมด/ }));
    await waitFor(() => expect(queued).toHaveLength(2));
    expect(lastRows()).toEqual(["m1", "m2", "m3"]);

    await userEvent.click(screen.getByRole("button", { name: /ล้าง$/ }));
    await userEvent.click(await screen.findByRole("button", { name: "ล้างทั้งหมด" }));
    await waitFor(() => expect(queued).toHaveLength(3));
    expect(lastRows()).toEqual([]);

    expect(onlineWrites, "every edit joined the queued snapshot").toEqual([]);
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
  });

  it("with nothing queued, a tap still goes online as before", async () => {
    mount();
    await tap("นิค3");
    await waitFor(() => expect(unsavedWork().pending).toBe(0));
    expect(queued).toEqual([]);
    expect(onlineWrites).toEqual(["delete"]);
    expect(server).toEqual(["m1", "m2"]);
  });

  it("the base of a later offline edit is the set the server confirmed, not the screen's", async () => {
    mount();
    await tap("นิค3"); // online: the server confirms m3 is off
    await waitFor(() => expect(unsavedWork().pending).toBe(0));
    netDown = true;
    await tap("นิค2");
    await waitFor(() => expect(queued).toHaveLength(1));
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
  });
});
