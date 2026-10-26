// 2026-10-27 hunt (showrun-5). รีเซ็ต handed ดึง buffer's slack back with no check that
// the row still held what the drain left.
//
// The ledger kept only the buffer a row held BEFORE the drain, and รีเซ็ต wrote it back
// to every row whose buffer differed from it - with no buffer_seconds in the write's
// precondition. A dry run's ดึง buffer drains B 300 → 120; a staffer then re-plans B's
// buffer to 600 in the builder; รีเซ็ต wrote 300 over the 600 and the plan edit was
// lost. The ledger now keeps { before, after } and restores only a row that still
// holds `after`, guarded on it. A bare number is a ledger stored before this
// (localStorage outlives the deploy): it keeps the old rule.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within, act } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, fail, type SupabaseFake, type RecordedCall } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { AccountPanelProvider } from "@/components/account-panel";
import { runOrderTopic } from "@/lib/realtime";
import { EventLiveCaller, type RunSeqLive } from "@/components/event/event-live-caller";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/events/ev-1/run-order/live",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

const TENANT = "t1";
const FEST = "Fest";
const DATE = "2026-10-27";
const LEDGER_KEY = `cueiq-runorder-buffer:${TENANT}:${DATE}:${FEST}`;
const T0 = "2026-10-27T11:00:00.000Z";

function row(over: Partial<RunSeqLive> & { id: string }): RunSeqLive {
  return {
    sort_order: 1,
    title: "",
    kind: "band",
    planned_start: null,
    planned_end: null,
    buffer_seconds: 0,
    linked_event_id: null,
    actual_start: null,
    actual_end: null,
    status: "pending",
    offset_min: null,
    ...over,
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
beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  localStorage.clear();
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  server = [
    // the live act is running 3 minutes late
    row({ id: "A", sort_order: 1, title: "วงเปิด", status: "live", actual_start: T0, offset_min: 3 }),
    row({ id: "B", sort_order: 2, title: "Seishin Kakumei", buffer_seconds: 300 }),
  ];
  // a real compare-and-swap: the UPDATE lands only while every eq / is filter holds
  supa.setTable("run_sequence", (call: RecordedCall) => {
    const holds = (r: RunSeqLive) =>
      call.filters.every((f) => {
        const v = (r as unknown as Record<string, unknown>)[f.column];
        if (f.op === "eq") return v === f.value;
        if (f.op === "is") return v == null;
        return true;
      });
    if (call.verb === "update") {
      const hit = server.filter(holds);
      for (const r of hit) Object.assign(r, call.values as object);
      return ok(hit.map((r) => ({ id: r.id })));
    }
    return ok(server.map((r) => ({ ...r })));
  });
});
afterEach(() => cleanup());

function caller() {
  return (
    <AccountPanelProvider>
      <ConfirmProvider>
        <EventLiveCaller tenantId={TENANT} eventName={FEST} eventDate={DATE} eventId="ev-1" initial={server.map((r) => ({ ...r }))} canControl />
      </ConfirmProvider>
    </AccountPanelProvider>
  );
}

/** ดึง buffer: the 3 late minutes come out of B's 300 s, leaving 120. */
async function drainB() {
  await screen.findByText(/buffer 5น\./);
  fireEvent.click(screen.getByRole("button", { name: /ดึง buffer/ }));
  await waitFor(() => expect(server[1].buffer_seconds).toBe(120));
  await screen.findByText(/buffer 2น\./);
}

/** รีเซ็ต, confirmed - and the write it sent to B. */
async function resetAndReadB(): Promise<RecordedCall> {
  supa.query.clearCalls();
  fireEvent.click(await screen.findByRole("button", { name: /^รีเซ็ต$/ }));
  const dialog = await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
  fireEvent.click(within(dialog).getByRole("button", { name: /^รีเซ็ต$/ }));
  await waitFor(() => expect(supa.callsTo("run_sequence", "update").some((c) => c.eq.id === "B")).toBe(true));
  return supa.callsTo("run_sequence", "update").find((c) => c.eq.id === "B")!;
}

describe("รีเซ็ต hands ดึง buffer's slack back", () => {
  it("not over a buffer the builder re-planned after the drain", async () => {
    render(caller());
    await drainB();

    // a staffer re-plans B's buffer to 10 minutes in the builder; the board re-reads
    server[1].buffer_seconds = 600;
    await act(async () => {
      supa.channelFor(runOrderTopic(TENANT, DATE, FEST))!.emit("changed", { sender: "builder" });
    });
    await screen.findByText(/buffer 10น\./);

    const toB = await resetAndReadB();
    expect((toB.values as Record<string, unknown>).buffer_seconds).toBeUndefined();
    await waitFor(() => expect(server[1].status).toBe("pending"));
    expect(server[1].buffer_seconds).toBe(600); // the plan edit stands
  });

  it("over what the drain left, and only while the row still holds it", async () => {
    render(caller());
    await drainB();
    expect(JSON.parse(localStorage.getItem(LEDGER_KEY)!)).toEqual({ B: { before: 300, after: 120 } });

    const toB = await resetAndReadB();
    expect((toB.values as Record<string, unknown>).buffer_seconds).toBe(300);
    // guarded: the restore lands only on a row that still holds the drain's 120
    expect(toB.filters).toContainEqual(expect.objectContaining({ op: "eq", column: "buffer_seconds", value: 120 }));
    await waitFor(() => expect(server[1].buffer_seconds).toBe(300));
    expect(localStorage.getItem(LEDGER_KEY)).toBeNull(); // handed back - the ledger is spent
  });

  it("a second drain after a re-plan hands back the NEW plan, not the first one", async () => {
    render(caller());
    await drainB(); // 300 → 120

    // re-planned to 600, and the act runs 4 minutes late again: 600 → 360
    server[1].buffer_seconds = 600;
    server[0].offset_min = 4;
    await act(async () => {
      supa.channelFor(runOrderTopic(TENANT, DATE, FEST))!.emit("changed", { sender: "builder" });
    });
    await screen.findByText(/buffer 10น\./);
    fireEvent.click(screen.getByRole("button", { name: /ดึง buffer/ }));
    await waitFor(() => expect(server[1].buffer_seconds).toBe(360));
    expect(JSON.parse(localStorage.getItem(LEDGER_KEY)!)).toEqual({ B: { before: 600, after: 360 } });
  });

  it("a second drain that is REFUSED leaves the ledger as the first one left it (ตาที่ 3)", async () => {
    render(caller());
    await drainB(); // 300 → 120, ledger { before 300, after 120 }
    // late again by 1 minute; this time the server refuses B's buffer write (not a network
    // error - nothing to queue): the drift lands, the drain does not
    server[0].offset_min = 1;
    supa.setTable("run_sequence", (call: RecordedCall) => {
      if (call.verb === "update" && "buffer_seconds" in (call.values as object)) return fail("permission denied for table run_sequence", 403);
      if (call.verb === "update") {
        const hit = server.filter((r) => r.id === call.eq.id);
        for (const r of hit) Object.assign(r, call.values as object);
        return ok(hit.map((r) => ({ id: r.id })));
      }
      return ok(server.map((r) => ({ ...r })));
    });
    await act(async () => {
      supa.channelFor(runOrderTopic(TENANT, DATE, FEST))!.emit("changed", { sender: "builder" });
    });
    await screen.findByText(/เลท +1/).catch(() => null);
    fireEvent.click(screen.getByRole("button", { name: /ดึง buffer/ }));
    await waitFor(() => expect(server[0].offset_min).toBe(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(server[1].buffer_seconds).toBe(120); // the drain never landed
    // was: { before: 300, after: 60 } - รีเซ็ต then read B as re-planned and gave nothing back
    expect(JSON.parse(localStorage.getItem(LEDGER_KEY)!)).toEqual({ B: { before: 300, after: 120 } });
  });

  it("(control) a ledger stored before { before, after } keeps the old rule", async () => {
    localStorage.setItem(LEDGER_KEY, JSON.stringify({ B: 300 }));
    server[1].buffer_seconds = 0;
    render(caller());
    await screen.findByRole("button", { name: /ดึง buffer/ });

    const toB = await resetAndReadB();
    expect((toB.values as Record<string, unknown>).buffer_seconds).toBe(300);
    expect(toB.filters.some((f) => f.column === "buffer_seconds")).toBe(false);
  });
});
