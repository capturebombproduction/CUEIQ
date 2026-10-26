// Desktop, 2026-10-27: a Mic Map edit that a SICK server refuses - a Supabase /
// Cloudflare 503 / 502 / 429, the server up and answering badly at the venue - must be
// queued like any other transient failure. isQueueableWriteError (lib/mgmt-outbox.ts)
// decides that from the HTTP status, but the Mic Map only destructured { data, error }
// and never passed the status into tryQueueChildList: the 503 arrives as an HTML page in
// error.message, matches none of the network words, and was classed a REAL rejection -
// toast "บันทึกไม่สำเร็จ", nothing queued, the holder's name on this screen only.
// The setlist builder's twin is setlist-builder.status-queue.test.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { makeSupabaseFake, makeSession, fail, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { MicMapEditor } from "@/components/event/mic-map-editor";
import { registerMgmtQueueSink } from "@/lib/mgmt-write";
import type { ChildListOp, NewMgmtOp } from "@/lib/mgmt-outbox";
import type { MicAssignment } from "@/lib/types";

const EVENT_ID = "eeeeeeee-3333-4333-8333-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-3333-4333-8333-tttttttttttt";
const A = "cccccccc-0000-4000-8000-000000000001";
const B = "cccccccc-0000-4000-8000-000000000002";
const PAGE_503 = "<html><body><h1>503 Service Unavailable</h1></body></html>";

const mic = (id: string, mic_number: number, holder_name: string): MicAssignment => ({
  id,
  tenant_id: TENANT_ID,
  event_id: EVENT_ID,
  mic_number,
  holder_name,
  order_index: 1,
  created_at: "2026-10-26T00:00:00Z",
});
const MICS = [mic(A, 1, "Ren"), mic(B, 2, "Mio")];

let supa: SupabaseFake;
let queued: NewMgmtOp[] = [];
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
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
        initialMics={MICS.map((r) => ({ ...r }))}
        members={[]}
        setlist={[]}
      />
    </ConfirmProvider>
  );
}

async function rename(value: string) {
  const el = screen.getByLabelText("ผู้ถือไมค์ 1");
  fireEvent.change(el, { target: { value } });
  await act(async () => {
    fireEvent.blur(el);
  });
}

describe("desktop Mic Map vs a server that is up and answering badly", () => {
  it("a 503 HTML page on a holder's name is queued for replay, and the tab says saved", async () => {
    supa.setScript({ mic_assignments: fail(PAGE_503, 503) });
    mount();
    await rename("Ren (กีตาร์)");
    expect(queued).toHaveLength(1);
    const rows = (queued[0] as ChildListOp).rows as MicAssignment[];
    expect(rows.find((r) => r.id === A)!.holder_name).toBe("Ren (กีตาร์)");
    expect(screen.getByText("บันทึกแล้ว")).toBeTruthy();
  });

  it("a 429 on เพิ่มไมค์ is queued too (the new mic stays on screen)", async () => {
    supa.setScript({ mic_assignments: fail("Too Many Requests", 429) });
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /เพิ่มไมค์/ }));
    });
    await waitFor(() => expect(queued).toHaveLength(1));
    expect((queued[0] as ChildListOp).rows).toHaveLength(3);
  });

  it("a 403 is still a real rejection - never queued", async () => {
    supa.setScript({ mic_assignments: fail("permission denied for table mic_assignments", 403) });
    mount();
    await rename("Ren (กีตาร์)");
    expect(queued).toEqual([]);
    expect(screen.getByText("ยังไม่ได้บันทึก")).toBeTruthy();
  });
});
