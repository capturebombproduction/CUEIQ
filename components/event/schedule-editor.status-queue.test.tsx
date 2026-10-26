// Desktop, 2026-10-27: a call-sheet edit that a SICK server refuses - a Supabase /
// Cloudflare 503 / 502 / 429, the server up and answering badly at the venue - must be
// queued like any other transient failure. isQueueableWriteError (lib/mgmt-outbox.ts)
// decides that from the HTTP status, but the schedule editor only destructured
// { data, error } and never passed the status into tryQueueChildList: the 503 arrives as
// an HTML page in error.message, matches none of the network words, and was classed a
// REAL rejection - toast "Save failed", nothing queued, the edit on this screen only.
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
import { ScheduleEditor } from "@/components/event/schedule-editor";
import { registerMgmtQueueSink } from "@/lib/mgmt-write";
import type { ChildListOp, NewMgmtOp } from "@/lib/mgmt-outbox";
import type { ScheduleItem } from "@/lib/types";

const EVENT_ID = "eeeeeeee-2222-4222-8222-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-2222-4222-8222-tttttttttttt";
const A = "bbbbbbbb-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const PAGE_503 = "<html><body><h1>503 Service Unavailable</h1></body></html>";

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
const ROWS = [row(A, 1, { kind: "on_location" }), row(B, 2, { kind: "stage" })];

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
      <ScheduleEditor
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        eventName="Show"
        editable
        initialItems={ROWS.map((r) => ({ ...r }))}
      />
    </ConfirmProvider>
  );
}

async function relabel(container: HTMLElement, value: string) {
  const el = container.querySelector<HTMLInputElement>(`#sc-${A}-label`)!;
  fireEvent.change(el, { target: { value } });
  await act(async () => {
    fireEvent.blur(el);
  });
}

describe("desktop call sheet vs a server that is up and answering badly", () => {
  it("a 503 HTML page on a retyped row is queued for replay, and the tab says saved", async () => {
    supa.setScript({ schedule_items: fail(PAGE_503, 503) });
    const { container } = mount();
    await relabel(container, "ถึงหน้างาน");
    expect(queued).toHaveLength(1);
    const rows = (queued[0] as ChildListOp).rows as ScheduleItem[];
    expect(rows.find((r) => r.id === A)!.label).toBe("ถึงหน้างาน");
    expect(screen.getByText("บันทึกแล้ว")).toBeTruthy();
  });

  it("a 502 on an added row is queued too (the row stays on screen)", async () => {
    supa.setScript({ schedule_items: fail("<html>502 Bad Gateway</html>", 502) });
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /แถวว่าง/ }));
    });
    await waitFor(() => expect(queued).toHaveLength(1));
    expect((queued[0] as ChildListOp).rows).toHaveLength(3);
  });

  it("a 403 is still a real rejection - never queued", async () => {
    supa.setScript({ schedule_items: fail("permission denied for table schedule_items", 403) });
    const { container } = mount();
    await relabel(container, "ถึงหน้างาน");
    expect(queued).toEqual([]);
    expect(screen.getByText("ยังไม่ได้บันทึก")).toBeTruthy();
  });
});
