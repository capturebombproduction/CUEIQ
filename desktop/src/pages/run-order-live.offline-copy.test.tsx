// The desktop's offline board follows the board, not the page load (2026-10-26).
//
// desktop/src/data/run-order.ts wrote the "runlive:<id>" read-cache ONLY when the page
// loaded. Nothing the board did afterwards - its own committed presses, every refetch
// it applied - reached that cache. So when the operator left คุมคิว Live during a wifi
// outage (a band's setlist, the back key, an app restart) and came back, the "offline
// copy" was the board as it stood when the page was FIRST opened online. The notice
// says "คุมคิวต่อได้ตามปกติ", and every press made on that rewound board was built on
// rows the server had left behind long ago.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import { makeSession, makeSupabaseFake, offline, ok, type RecordedCall } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

const h = vi.hoisted(() => ({ supa: null as unknown, ws: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("~/data/workspace-context", () => ({
  useWorkspace: () => ({ loading: false, ws: h.ws, reload: () => {} }),
}));
vi.mock("@/components/account-panel", () => ({
  useAccountPanel: () => ({ open: false, setOpen: () => {} }),
}));

import { RunOrderLivePage } from "./run-order-live";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const EVENT_ID = "eeeeeeee-0000-4000-8000-000000000001";
const CACHE_KEY = `cueiq:cache:runlive:${EVENT_ID}`;

type Row = Record<string, unknown> & { id: string };
let server: Row[];

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
}

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });
}

function page() {
  return (
    <ConfirmProvider>
      <MemoryRouter initialEntries={[`/events/${EVENT_ID}/run-order/live`]}>
        <Routes>
          <Route path="/events/:id/run-order/live" element={<RunOrderLivePage />} />
        </Routes>
      </MemoryRouter>
    </ConfirmProvider>
  );
}

const cachedStatuses = () =>
  (JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "null") as { seqs: Row[] } | null)?.seqs.map(
    (r) => `${r.id}:${r.status}`
  );

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  window.localStorage.clear();
  setOnline(true);
  server = [
    { id: "A", sort_order: 1, title: "วงเปิด", kind: "band", planned_start: null, planned_end: null, buffer_seconds: 0, linked_event_id: null, status: "pending", actual_start: null, actual_end: null, offset_min: null },
    { id: "B", sort_order: 2, title: "Seishin Kakumei", kind: "band", planned_start: null, planned_end: null, buffer_seconds: 0, linked_event_id: null, status: "pending", actual_start: null, actual_end: null, offset_min: null },
  ];
  const supa = makeSupabaseFake({ session: makeSession() });
  supa.setTable("events", ok({ id: EVENT_ID, name: "A Lot Of Tone Fest", event_date: "2026-10-26" }));
  supa.setTable("run_sequence", (call: RecordedCall) => {
    // the venue wifi: with it down, nothing reaches the server
    if (!navigator.onLine) return offline();
    const hit = server.filter((r) =>
      call.filters.every((f) => (f.op === "eq" && f.column in r ? r[f.column] === f.value : true))
    );
    if (call.verb === "update") {
      for (const r of hit) Object.assign(r, call.values as object);
      return ok(hit.map((r) => ({ id: r.id })));
    }
    return ok(server.map((r) => ({ ...r })));
  });
  h.supa = supa;
  h.ws = {
    user: { id: "u1", email: "staff@cueiq.local", name: "Staff" },
    membership: { tenant_id: TENANT, role: "admin" },
    tenant: null,
    groups: [],
    groupRoles: [],
    perms: makePerms("admin", []),
  };
});

afterEach(() => {
  cleanup();
  setOnline(true);
});

describe("desktop คุมคิว Live — leaving and coming back during an outage", () => {
  it("comes back to the board this machine was showing, not the one it opened with", async () => {
    // online: open the board, start the show (committed on the server)
    render(page());
    fireEvent.click(await screen.findByRole("button", { name: /เริ่มงาน/ }));
    await waitFor(() => expect(server[0].status).toBe("live"));
    await screen.findByRole("button", { name: /จบ \+ ต่อไป · Seishin Kakumei/ });
    cleanup(); // e.g. "เปิด setlist วงนี้" → the band's Live Mode

    // the venue wifi drops; the operator comes back to คุมคิว Live
    setOnline(false);
    render(page());
    await screen.findByText(/นี่คือคิวที่เครื่องนี้เก็บไว้ล่าสุด/);
    // the act this machine itself started is still on stage - not "เริ่มงาน" again
    expect(screen.queryByRole("button", { name: /เริ่มงาน/ })).toBeNull();
    expect(screen.getByRole("button", { name: /จบ \+ ต่อไป · Seishin Kakumei/ })).toBeInTheDocument();
  });

  it("the copy holds what the server holds - a press that only queued rides the queue, not the copy", async () => {
    render(page());
    fireEvent.click(await screen.findByRole("button", { name: /เริ่มงาน/ }));
    await waitFor(() => expect(cachedStatuses()).toEqual(["A:live", "B:pending"]));

    // offline: จบ + ต่อไป queues on this device
    setOnline(false);
    fireEvent.click(screen.getByRole("button", { name: /จบ \+ ต่อไป · Seishin Kakumei/ }));
    await screen.findByText(/ค้างซิงค์ 2 รายการ/);
    // the server never saw it, so neither does the copy
    expect(cachedStatuses()).toEqual(["A:live", "B:pending"]);
    cleanup();

    // ...and coming back, the queue lays the press back over the copy: B on stage
    render(page());
    await screen.findByText(/ค้างซิงค์ 2 รายการ/);
    await screen.findByRole("button", { name: /จบงาน/ });
    expect(screen.queryByRole("button", { name: /เริ่มงาน/ })).toBeNull();
  });
});
