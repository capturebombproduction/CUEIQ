// Another account's unsent presses are not this board's (2026-10-30, hunt 11).
//
// Hunt 10 gave every queued press its owner, and a flush signed in as someone else leaves
// that account's presses alone until it signs in here again. The board did not know: it
// still laid them over the server rows and counted them in "ค้างซิงค์" - so the account
// signed in saw an act live (or done) that the server and every other device never had,
// under a banner it could neither send nor clear. Now they stay off the board and the
// banner, and are named in one quiet line. A press made ON one of their rows still folds
// into them and replays under the account signed in (unitOwner's rule) - and this
// account's own queued press overlays and replays exactly as before.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { AccountPanelProvider } from "@/components/account-panel";
import { enqueueRunSeq, flushRunSeqOutbox, listRunSeqOps } from "@/lib/run-order-outbox";
import { runOrderTopic } from "@/lib/realtime";
import { EventLiveCaller, type RunSeqLive } from "./event-live-caller";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/events/ev-1/run-order/live",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

const ME = "bbbbbbbb-0000-4000-8000-00000000000b";
const OTHER = "aaaaaaaa-0000-4000-8000-00000000000a";
const TENANT = "t1";
const FEST = "Ichiban idol vol.26 Halloween";
const DATE = "2026-10-31";
const T0 = "2026-10-31T10:20:00.000Z";
const T1 = "2026-10-31T10:40:00.000Z";

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

/** Who supabase-js says is signed in on this device (where the outbox reads the owner). */
function signIn(userId: string) {
  window.localStorage.setItem(
    "sb-testref-auth-token",
    JSON.stringify({ access_token: "t", refresh_token: "r", user: { id: userId } })
  );
}

let supa: SupabaseFake;
let server: RunSeqLive[];

/** run_sequence honouring the update's compare-and-swap. */
function casTable() {
  supa.setTable("run_sequence", (call) => {
    if (call.verb !== "update") {
      const hit = call.eq.id ? server.filter((r) => r.id === call.eq.id) : server;
      const rows = hit.map((r) => ({ ...r }));
      return ok(call.terminal === "maybeSingle" ? (rows[0] ?? null) : rows);
    }
    const r = server.find((x) => x.id === call.eq.id)!;
    const holds = call.filters.every((f) =>
      f.op === "eq"
        ? (r as Record<string, unknown>)[f.column] === f.value
        : f.op === "is"
          ? (r as Record<string, unknown>)[f.column] == null
          : true
    );
    if (!holds) return ok([]);
    Object.assign(r, call.values as object);
    return ok([{ id: r.id }]);
  });
}

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  window.localStorage.clear();
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  server = [
    row({ id: "A", sort_order: 1, title: "วงเปิด", status: "live", actual_start: T0, offset_min: 0 }),
    row({ id: "B", sort_order: 2, title: "Seishin Kakumei" }),
    row({ id: "C", sort_order: 3, title: "ปิดงาน" }),
  ];
  casTable();
});

/** "จบ + ต่อไป" A→B pressed offline on this device by `who`. */
async function queuedEndAndNext(who: string) {
  signIn(who);
  const base = { festival: `${FEST} · ${DATE}`, queuedAt: 1, presses: [`p-${who}`], topic: runOrderTopic(TENANT, DATE, FEST) };
  await enqueueRunSeq({ ...base, rowId: "A", label: "วงเปิด", patch: { status: "done", actual_end: T1 }, expect: { status: "live" } });
  await enqueueRunSeq({ ...base, rowId: "B", label: "Seishin Kakumei", patch: { status: "live", actual_start: T1, offset_min: 0 }, expect: { status: "pending" } });
}

function mount() {
  render(
    <AccountPanelProvider>
      <ConfirmProvider>
        <EventLiveCaller tenantId={TENANT} eventName={FEST} eventDate={DATE} eventId="ev-1" initial={server.map((r) => ({ ...r }))} canControl />
      </ConfirmProvider>
    </AccountPanelProvider>
  );
}

const nowTitle = () =>
  within(document.querySelector<HTMLElement>(".now")!).getByRole("heading", { level: 2 }).textContent;

describe("EventLiveCaller — another account's queued presses", () => {
  it("this account's own queued press: laid over the board and counted, then replayed - as before", async () => {
    await queuedEndAndNext(ME);
    mount();
    await screen.findByText(/ค้างซิงค์ 2 รายการ/);
    expect(nowTitle()).toBe("Seishin Kakumei");
    expect(screen.queryByTestId("runseq-foreign-queued")).toBeNull();

    await act(async () => {
      await flushRunSeqOutbox();
    });
    expect(server.map((r) => r.status)).toEqual(["done", "live", "pending"]);
    await waitFor(() => expect(screen.queryByText(/ค้างซิงค์/)).toBeNull());
    expect(nowTitle()).toBe("Seishin Kakumei");
  });

  it("another account's: the board shows what the server holds, no banner, one quiet line", async () => {
    await queuedEndAndNext(OTHER);
    signIn(ME);
    mount();
    await screen.findByTestId("runseq-foreign-queued");
    expect(screen.getByTestId("runseq-foreign-queued").textContent).toContain("มีคิวของบัญชีอื่น 2 รายการ");
    expect(nowTitle()).toBe("วงเปิด");
    expect(screen.queryByText(/ค้างซิงค์/)).toBeNull();

    // and a flush here still leaves it alone (hunt 10)
    await act(async () => {
      await flushRunSeqOutbox();
    });
    expect(server.map((r) => r.status)).toEqual(["live", "pending", "pending"]);
    expect((await listRunSeqOps()).length).toBe(2);
  });

  it("a press on its rows still folds into it and replays under this account", async () => {
    await queuedEndAndNext(OTHER);
    signIn(ME);
    mount();
    await screen.findByTestId("runseq-foreign-queued");
    const key = await screen.findByRole("button", { name: /จบ \+ ต่อไป · Seishin Kakumei/ });
    await act(async () => {
      key.click();
    });
    // queued behind the other account's press (one record per row), not written past it
    await waitFor(async () => {
      const ops = await listRunSeqOps();
      expect(ops.length).toBe(2);
      expect(ops.every((o) => o.owner === undefined)).toBe(true);
    });
    await act(async () => {
      await flushRunSeqOutbox();
    });
    expect(server.map((r) => r.status)).toEqual(["done", "live", "pending"]);
    await waitFor(() => expect(screen.queryByTestId("runseq-foreign-queued")).toBeNull());
    await waitFor(() => expect(nowTitle()).toBe("Seishin Kakumei"));
  });
});
