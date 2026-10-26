// The caller must stop painting presses another TAB already replayed (2026-10-26).
//
// EventLiveCaller lays every queued press over the rows it renders. It re-read that
// queue only on RUNSEQ_OUTBOX_EVENT - which the outbox dispatched on ITS OWN window.
// Every web tab mounts its own OutboxFlusher over the SAME IndexedDB, and a flush
// fires on visibilitychange, so with คุมคิว Live in one tab and the Overview in
// another, switching tabs let the OTHER tab replay the presses. This tab never heard
// it, its own later flushes found an empty queue and returned without a word, and
// its stale list stayed laid over every refetch: once the show moved on, the act
// that had already finished was put back on stage, and the next press built on that
// board put a second act live.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { AccountPanelProvider } from "@/components/account-panel";
import { enqueueRunSeq, flushRunSeqOutbox } from "@/lib/run-order-outbox";
import { runOrderTopic } from "@/lib/realtime";
import { EventLiveCaller, type RunSeqLive } from "./event-live-caller";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/events/ev-1/run-order/live",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

const TENANT = "t1";
const FEST = "A Lot Of Tone Fest";
const DATE = "2026-10-26";
const T0 = "2026-10-26T11:00:00.000Z";
const T1 = "2026-10-26T11:30:00.000Z"; // this tab's offline จบ+ต่อไป (A→B)
const T2 = "2026-10-26T12:00:00.000Z"; // later: the show moves on (B→C)

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

/** What the OTHER tab's flush leaves behind: the records are gone, and no event
 *  reached this window. */
function drainedByAnotherTab(): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("cueiq-outbox", 2);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("runseq", "readwrite");
      tx.objectStore("runseq").clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

let supa: SupabaseFake;
let server: RunSeqLive[];

/** run_sequence honouring the update's compare-and-swap. */
function casTable() {
  supa.setTable("run_sequence", (call) => {
    if (call.verb !== "update") return ok(server.map((r) => ({ ...r })));
    const r = server.find((x) => x.id === call.eq.id)!;
    const holds = call.filters.every((f) =>
      f.op === "eq" ? (r as Record<string, unknown>)[f.column] === f.value : true
    );
    if (!holds) return ok([]);
    Object.assign(r, call.values as object);
    return ok([{ id: r.id }]);
  });
}

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  // the press A→B, already replayed by the other tab: the server holds it
  server = [
    row({ id: "A", sort_order: 1, title: "วงเปิด", status: "done", actual_start: T0, actual_end: T1, offset_min: 0 }),
    row({ id: "B", sort_order: 2, title: "Seishin Kakumei", status: "live", actual_start: T1, offset_min: 0 }),
    row({ id: "C", sort_order: 3, title: "เกมชิงรางวัล" }),
    row({ id: "D", sort_order: 4, title: "ปิดงาน" }),
  ];
  casTable();
});

async function mountWithThisTabsQueuedPress() {
  const base = { festival: `${FEST} · ${DATE}`, queuedAt: 1, presses: ["p1"], topic: runOrderTopic(TENANT, DATE, FEST) };
  await enqueueRunSeq({ ...base, rowId: "A", label: "วงเปิด", patch: { status: "done", actual_end: T1 }, expect: { status: "live" } });
  await enqueueRunSeq({ ...base, rowId: "B", label: "Seishin Kakumei", patch: { status: "live", actual_start: T1, offset_min: 0 }, expect: { status: "pending" } });
  const initial = server.map((r) => ({ ...r }));
  render(
    <AccountPanelProvider>
      <ConfirmProvider>
        <EventLiveCaller tenantId={TENANT} eventName={FEST} eventDate={DATE} eventId="ev-1" initial={initial} canControl />
      </ConfirmProvider>
    </AccountPanelProvider>
  );
  await screen.findByText(/ค้างซิงค์ 2 รายการ/);
}

/** The show moves on (B→C) and this board hears it from another device. */
async function showMovesOnElsewhere() {
  server[1] = { ...server[1], status: "done", actual_end: T2 };
  server[2] = { ...server[2], status: "live", actual_start: T2, offset_min: 0 };
  await act(async () => {
    supa.channelFor(runOrderTopic(TENANT, DATE, FEST))!.emit("changed", { sender: "other-device" });
  });
}

const nowTitle = () =>
  within(document.querySelector<HTMLElement>(".now")!).getByRole("heading", { level: 2 }).textContent;

describe("EventLiveCaller — a queue another tab already replayed", () => {
  it("a refetch re-reads the queue: presses no longer queued stop being laid over the board", async () => {
    await mountWithThisTabsQueuedPress();
    await drainedByAnotherTab(); // and no word reached this window
    await showMovesOnElsewhere();

    await waitFor(() => expect(nowTitle()).toBe("เกมชิงรางวัล"));
    expect(screen.queryByText(/ค้างซิงค์/)).toBeNull();
  });

  it("…so the next จบ+ต่อไป ends the act on stage and starts the one after: one act live", async () => {
    await mountWithThisTabsQueuedPress();
    await drainedByAnotherTab();
    await showMovesOnElsewhere();

    // the key ends C (on stage) - not B again, which the stale overlay put back
    const key = await screen.findByRole("button", { name: /จบ \+ ต่อไป · ปิดงาน/ });
    await waitFor(() => expect(nowTitle()).toBe("เกมชิงรางวัล"));
    await act(async () => {
      key.click();
    });
    await waitFor(() => expect(server.find((r) => r.id === "D")!.status).toBe("live"));
    expect(server.filter((r) => r.status === "live").map((r) => r.id)).toEqual(["D"]);
    expect(server.find((r) => r.id === "C")!.status).toBe("done");
  });

  it("another tab's word reaches this board: it re-reads the queue at once", async () => {
    await mountWithThisTabsQueuedPress();
    await drainedByAnotherTab();
    // what the other tab's announce() posts, from a channel of its own
    const otherTab = new BroadcastChannel("cueiq:runseq-outbox");
    try {
      otherTab.postMessage({ from: "the-overview-tab" });
      await waitFor(() => expect(screen.queryByText(/ค้างซิงค์/)).toBeNull());
    } finally {
      otherTab.close();
    }
  });

  it("this tab's own flush finding nothing to replay still tells this board to re-read", async () => {
    await mountWithThisTabsQueuedPress();
    await drainedByAnotherTab();
    await act(async () => {
      await flushRunSeqOutbox();
    });
    await waitFor(() => expect(screen.queryByText(/ค้างซิงค์/)).toBeNull());
  });
});
