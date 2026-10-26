// The base an offline schedule edit is queued against must be the list the SERVER holds.
//
// Label / start / end / location / notes setLocal on every key and save on blur, from a
// render whose `items` already holds the typed value. The snapshot used to be queued
// with `baseRows: items`, so base == rows and the online-wins guard
// (lib/mgmt-outbox.ts childFlushDecision) parked the venue's own call-time edit as
// "เวอร์ชันออนไลน์ถูกแก้ไขใหม่กว่าของเครื่องนี้" although nobody had touched the online copy.
// Same bug, same fix as components/event/setlist-builder.offline-base.test.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
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
import { registerMgmtQueueSink } from "@/lib/mgmt-write";
import { childFlushDecision, type ChildListOp, type NewMgmtOp } from "@/lib/mgmt-outbox";
import type { ScheduleItem } from "@/lib/types";

const EVENT_ID = "eeeeeeee-2222-4222-8222-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-2222-4222-8222-tttttttttttt";
const A = "bbbbbbbb-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

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

function table(call: RecordedCall) {
  if (netDown) return offline();
  if (call.verb === "update") {
    const r = server.find((x) => x.id === call.eq.id);
    if (!r) return ok([]);
    Object.assign(r, call.values as object);
    return ok([{ id: r.id }]);
  }
  return ok(server.map((r) => ({ ...r })));
}

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  server = [
    row(A, 1, { kind: "on_location", start_time: "14:00:00" }),
    row(B, 2, { kind: "stage", start_time: "18:00:00" }),
  ];
  netDown = false;
  supa.setTable("schedule_items", table);
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

describe("schedule editor: the base an offline edit is queued against", () => {
  it("a label typed offline replays as 'apply' against an untouched server", async () => {
    netDown = true;
    const { container } = mount();
    await type(container.querySelector<HTMLInputElement>(`#sc-${A}-label`)!, "ถึงหน้างาน");
    expect(queued, "the offline edit reached the outbox").toHaveLength(1);
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
  });

  it("a second offline edit after an online save still carries the server's list", async () => {
    const { container } = mount();
    await type(container.querySelector<HTMLInputElement>(`#sc-${A}-label`)!, "ถึงหน้างาน");
    expect(server[0].label).toBe("ถึงหน้างาน"); // landed online
    netDown = true;
    await type(container.querySelector<HTMLInputElement>(`#sc-${B}-label`)!, "ขึ้นเวที");
    expect(queued).toHaveLength(1);
    expect(childFlushDecision(queued[0] as ChildListOp, server)).toBe("apply");
  });
});
