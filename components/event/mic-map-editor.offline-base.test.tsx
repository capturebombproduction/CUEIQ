// The base an offline mic-map edit is queued against must be the list the SERVER holds.
//
// A holder's name types into `mics` on every key and saves on blur, from a render whose
// `mics` already holds the typed name. The snapshot was queued with `baseRows: mics`, so
// base == rows and the online-wins guard (lib/mgmt-outbox.ts childFlushDecision) parked
// the desktop's own offline name as "เวอร์ชันออนไลน์ถูกแก้ไขใหม่กว่าของเครื่องนี้" although
// nobody had touched the online copy - and the queue keeps the FIRST base, so every later
// offline mic edit of the session parked with it. The schedule editor's and the setlist
// builder's twin (their *.offline-base.test.tsx), left open by the 2026-10-26 hunt.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, act, screen } from "@testing-library/react";
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
import { registerMgmtQueueSink } from "@/lib/mgmt-write";
import { childFlushDecision, type ChildListOp, type NewMgmtOp } from "@/lib/mgmt-outbox";
import type { MicAssignment } from "@/lib/types";

const EVENT_ID = "eeeeeeee-3333-4333-8333-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-3333-4333-8333-tttttttttttt";
const A = "cccccccc-0000-4000-8000-000000000001";
const B = "cccccccc-0000-4000-8000-000000000002";

const mic = (id: string, mic_number: number, holder_name: string): MicAssignment => ({
  id,
  tenant_id: TENANT_ID,
  event_id: EVENT_ID,
  mic_number,
  holder_name,
  order_index: 1,
  created_at: "2026-10-26T00:00:00Z",
});

let supa: SupabaseFake;
let queued: NewMgmtOp[] = [];
let server: MicAssignment[];
let netDown = false;

function table(call: RecordedCall) {
  if (netDown) return offline();
  if (call.verb === "update") {
    // by id (a name, an order) or by event + mic number (a renumber)
    const hit = server.filter((x) =>
      Object.entries(call.eq).every(([k, v]) => (x as unknown as Record<string, unknown>)[k] === v)
    );
    for (const r of hit) Object.assign(r, call.values as object);
    return ok(hit.map((r) => ({ id: r.id })));
  }
  return ok(server.map((r) => ({ ...r })));
}

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  server = [mic(A, 1, "Ren"), mic(B, 2, "Mio")];
  netDown = false;
  supa.setTable("mic_assignments", table);
  queued = [];
  registerMgmtQueueSink(async (op) => {
    queued.push(op);
  });
});
afterEach(() => {
  registerMgmtQueueSink(null);
  cleanup();
});

function mount() {
  return render(
    <ConfirmProvider>
      <MicMapEditor
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        eventName="Show"
        editable
        initialMics={server.map((r) => ({ ...r }))}
        members={[]}
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

describe("mic map editor: the base an offline edit is queued against", () => {
  it("a holder name typed offline replays as 'apply' against an untouched server", async () => {
    netDown = true;
    mount();
    await type(screen.getByLabelText("ผู้ถือไมค์ 1"), "Ren (กีตาร์)");
    expect(queued, "the offline edit reached the outbox").toHaveLength(1);
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
  });

  it("a second offline edit after an online save still carries the server's list", async () => {
    mount();
    await type(screen.getByLabelText("ผู้ถือไมค์ 1"), "Ren (กีตาร์)");
    expect(server[0].holder_name).toBe("Ren (กีตาร์)"); // landed online
    netDown = true;
    await type(screen.getByLabelText("ผู้ถือไมค์ 2"), "Mio (ร้องนำ)");
    expect(queued).toHaveLength(1);
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
  });

  it("a renumber that landed online is the base of the next offline edit", async () => {
    mount();
    const num = screen.getByLabelText("หมายเลขไมค์ 2");
    fireEvent.change(num, { target: { value: "5" } });
    await act(async () => {
      fireEvent.blur(num);
    });
    await act(async () => {}); // the renumber's write settles
    netDown = true;
    await type(screen.getByLabelText("ผู้ถือไมค์ 1"), "Ren (กีตาร์)");
    expect(queued).toHaveLength(1);
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
  });
});
