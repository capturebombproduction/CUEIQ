// The board's own path for a press on a row whose earlier press parked (2026-10-27,
// hunt 6): button → apply() → queueOffline → enqueueRunSeq → the shell's flush.
// Another controller drove the board while this device was offline, so this device's
// จบ + ต่อไป parked (correctly) and sits on the red panel. The operator, offline again,
// presses จบ + ต่อไป on the board the server holds. Online that press is a direct write
// and lands; offline it used to be folded into the PARKED op, park at once, and take the
// next act's start into the park with it - every device kept the act it ended on stage.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, waitFor } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, offline, type SupabaseFake, type RecordedCall } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { AccountPanelProvider } from "@/components/account-panel";
import { enqueueRunSeq, flushRunSeqOutbox, listRunSeqOps, RUNSEQ_QUEUED_MESSAGE } from "@/lib/run-order-outbox";
import { runOrderTopic } from "@/lib/realtime";
import { EventLiveCaller, type RunSeqLive } from "@/components/event/event-live-caller";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/events/ev-1/run-order/live",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

const TENANT = "t1";
const FEST = "A Lot Of Tone Fest";
const DATE = "2026-10-27";
const TOPIC = runOrderTopic(TENANT, DATE, FEST);

function row(over: Partial<RunSeqLive> & { id: string }): RunSeqLive {
  return {
    sort_order: 1, title: "", kind: "band", planned_start: null, planned_end: null,
    buffer_seconds: 0, linked_event_id: null, actual_start: null, actual_end: null,
    status: "pending", offset_min: null, ...over,
  };
}
function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });
}

let supa: SupabaseFake;
let server: RunSeqLive[];
let wifi: boolean;

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  localStorage.clear();
  vi.clearAllMocks();
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  // the server after the OTHER device's จบ + ต่อไป (A → B)
  server = [
    row({ id: "A", sort_order: 1, title: "วงเปิด", status: "done", actual_start: "2026-10-27T11:00:00.000Z", actual_end: "2026-10-27T11:20:00.000Z", offset_min: 0 }),
    row({ id: "B", sort_order: 2, title: "Seishin Kakumei", status: "live", actual_start: "2026-10-27T11:20:00.000Z", offset_min: 0 }),
    row({ id: "C", sort_order: 3, title: "วงปิด" }),
  ];
  wifi = true;
  const matches = (r: Record<string, unknown>, call: RecordedCall) =>
    call.filters.every((f) =>
      f.op === "eq" ? r[f.column] === f.value : f.op === "is" ? r[f.column] == null : f.op === "in" ? (f.value as unknown[]).includes(r[f.column]) : true
    );
  supa.setTable("run_sequence", (call: RecordedCall) => {
    if (!wifi) return offline();
    const rows = server as unknown as Record<string, unknown>[];
    if (call.verb === "update") {
      const hit = rows.filter((r) => matches(r, call));
      for (const r of hit) Object.assign(r, call.values as object);
      return ok(hit.map((r) => ({ id: r.id })));
    }
    const hit = rows.filter((r) => matches(r, call)).map((r) => ({ ...r }));
    return ok(call.terminal === "maybeSingle" ? (hit[0] ?? null) : hit);
  });
});
afterEach(() => cleanup());

describe("an offline press on a row whose earlier press parked", () => {
  it("is queued as its own press and lands when the wifi is back; the parked sibling stays on the panel", async () => {
    // this device's own offline A → B, which parks against the other device's A → B
    const base = { festival: `${FEST} · ${DATE}`, topic: TOPIC, queuedAt: 1, presses: ["p-old"] };
    await enqueueRunSeq({ ...base, rowId: "A", label: "วงเปิด", patch: { status: "done", actual_end: "2026-10-27T11:21:00.000Z" }, expect: { status: "live" } });
    await enqueueRunSeq({ ...base, rowId: "B", label: "Seishin Kakumei", patch: { status: "live", actual_start: "2026-10-27T11:21:00.000Z", offset_min: 1 }, expect: { status: "pending" } });
    await flushRunSeqOutbox();
    expect((await listRunSeqOps()).every((o) => o.conflict)).toBe(true);

    // the board opens on what the server holds (B live), the red panel above it
    render(
      <AccountPanelProvider>
        <ConfirmProvider>
          <EventLiveCaller tenantId={TENANT} eventName={FEST} eventDate={DATE} eventId="ev-1" initial={server.map((r) => ({ ...r }))} canControl />
        </ConfirmProvider>
      </AccountPanelProvider>
    );
    const nextKey = await screen.findByRole("button", { name: /จบ \+ ต่อไป · วงปิด/ });

    // wifi drops; B's set ends; the operator presses จบ + ต่อไป
    wifi = false;
    await act(async () => {
      fireEvent.click(nextKey);
    });
    await waitFor(() => expect(h.toast.success).toHaveBeenCalled());
    expect(h.toast.success).toHaveBeenCalledWith(RUNSEQ_QUEUED_MESSAGE, expect.anything());
    // what the press left on this device: its own two rows, waiting - not parked
    const after = Object.fromEntries((await listRunSeqOps()).map((o) => [o.rowId, o]));
    expect(after.B).toMatchObject({ patch: { status: "done" }, expect: { status: "live" } });
    expect(after.B.conflict).toBeFalsy();
    expect(after.C.conflict).toBeFalsy();
    expect(await screen.findByText(/ค้างซิงค์ 2 รายการ/)).toBeTruthy();

    // wifi back: the shell's flusher replays the queue
    wifi = true;
    await act(async () => {
      await flushRunSeqOutbox();
    });

    expect(server.find((r) => r.id === "B")!.status).toBe("done");
    expect(server.find((r) => r.id === "C")!.status).toBe("live");
    // the old press's other half is still a human's call
    const left = await listRunSeqOps();
    expect(left.map((o) => [o.rowId, !!o.conflict])).toEqual([["A", true]]);
    await waitFor(() =>
      expect(document.body.textContent).toContain("คิวถูกเปลี่ยนจากเครื่องอื่นระหว่างที่เครื่องนี้ออฟไลน์ (1)")
    );
  });
});
