// The desktop's offline board copy follows the FESTIVAL, and the presses that land while
// no board is on screen (2026-10-27 desktop hunt).
//
// run-order-live.offline-copy.test.tsx pins that the copy follows the board while คุมคิว
// Live is mounted (c4388cf). Two ways the copy still rewound a running show in an outage:
//  (1) the copy is keyed by the event the board was opened from (runlive:<id>), but the
//      board is festival-wide. The way back from "เปิด setlist วงนี้" is Live Mode's back
//      link -> /events/<band event> -> "ดูบอร์ดเต็ม" -> /events/<band event>/run-order/live:
//      another key, holding whatever that door last saw - "เริ่มงาน" for a show that runs.
//  (2) presses this machine queued land from the shell's OutboxFlusher while the board is
//      NOT mounted (the operator is on the band's setlist): the queue empties, nobody wrote
//      the copy, and reopened offline the board showed the pre-press acts with no overlay
//      left to correct it.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import { makeSession, makeSupabaseFake, offline, ok, type RecordedCall } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { flushRunSeqOutbox } from "@/lib/run-order-outbox";

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
// Two band events of ONE festival (same tenant + name + date = one run_sequence board)
const ENTRY = "eeeeeeee-0000-4000-8000-000000000001"; // Overview's "คุมคิว (Live)" door
const BAND = "eeeeeeee-0000-4000-8000-000000000002"; // Seishin's own event page door
// A different festival day this machine also holds a copy of
const OTHER_DAY = "eeeeeeee-0000-4000-8000-000000000003";
const OTHER_KEY = `cueiq:cache:runlive:${OTHER_DAY}`;

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

function page(eventId: string) {
  return (
    <ConfirmProvider>
      <MemoryRouter initialEntries={[`/events/${eventId}/run-order/live`]}>
        <Routes>
          <Route path="/events/:id/run-order/live" element={<RunOrderLivePage />} />
        </Routes>
      </MemoryRouter>
    </ConfirmProvider>
  );
}

const band = (id: string, sort: number, title: string, linked: string | null): Row => ({
  id,
  sort_order: sort,
  title,
  kind: "band",
  planned_start: null,
  planned_end: null,
  buffer_seconds: 0,
  linked_event_id: linked,
  status: "pending",
  actual_start: null,
  actual_end: null,
  offset_min: null,
});

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  window.localStorage.clear();
  setOnline(true);
  server = [band("A", 1, "วงเปิด", null), band("B", 2, "Seishin Kakumei", BAND)];
  const supa = makeSupabaseFake({ session: makeSession() });
  // both doors name the same festival
  supa.setTable("events", ok({ id: ENTRY, name: "A Lot Of Tone Fest", event_date: "2026-10-26" }));
  supa.setTable("run_sequence", (call: RecordedCall) => {
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

describe("the desktop's offline board copy", () => {
  it("(1) reopened through the band's own event during an outage, it shows the board this machine last saw", async () => {
    // another festival day's copy - same name, other date - must not be touched
    const otherDay = JSON.stringify({
      name: "A Lot Of Tone Fest",
      date: "2026-10-27",
      seqs: [band("Z", 1, "วงวันพรุ่งนี้", null)],
    });
    window.localStorage.setItem(OTHER_KEY, otherDay);

    // pre-show check from Seishin's event page (ดูบอร์ดเต็ม): the copy for that door = nothing started
    render(page(BAND));
    await screen.findByRole("button", { name: /เริ่มงาน/ });
    cleanup();

    // show time, from Overview's door: start, then จบ + ต่อไป - all committed online
    render(page(ENTRY));
    fireEvent.click(await screen.findByRole("button", { name: /เริ่มงาน/ }));
    await waitFor(() => expect(server[0].status).toBe("live"));
    fireEvent.click(await screen.findByRole("button", { name: /จบ \+ ต่อไป · Seishin Kakumei/ }));
    await waitFor(() => expect(server[1].status).toBe("live"));
    cleanup(); // "เปิด setlist วงนี้" -> Seishin's Live Mode -> back -> Seishin's event page

    // wifi drops; ดูบอร์ดเต็ม from Seishin's event page
    setOnline(false);
    render(page(BAND));
    await screen.findByText(/นี่คือคิวที่เครื่องนี้เก็บไว้ล่าสุด/);
    // B is on stage on the server and on this machine's last board - the dock must say จบงาน
    expect(screen.queryByRole("button", { name: /เริ่มงาน/ })).toBeNull();
    expect(screen.getByRole("button", { name: /จบงาน/ })).toBeInTheDocument();

    expect(window.localStorage.getItem(OTHER_KEY)).toBe(otherDay);
  });

  it("(2) presses that land while the board is closed still reach the copy", async () => {
    render(page(ENTRY));
    fireEvent.click(await screen.findByRole("button", { name: /เริ่มงาน/ }));
    await waitFor(() => expect(server[0].status).toBe("live"));

    // outage: จบ + ต่อไป queues
    setOnline(false);
    fireEvent.click(screen.getByRole("button", { name: /จบ \+ ต่อไป · Seishin Kakumei/ }));
    await screen.findByText(/ค้างซิงค์ 2 รายการ/);
    cleanup(); // the operator opens Seishin's setlist

    // the wifi comes back for a minute: the shell's OutboxFlusher replays the press
    setOnline(true);
    await flushRunSeqOutbox();
    expect(server.map((r) => `${r.id}:${r.status}`)).toEqual(["A:done", "B:live"]);

    // ...and drops again before the operator is back on คุมคิว Live
    setOnline(false);
    render(page(ENTRY));
    await screen.findByText(/นี่คือคิวที่เครื่องนี้เก็บไว้ล่าสุด/);
    // the press this machine made (and the server now holds) must still be on the board
    expect(screen.getByRole("button", { name: /จบงาน/ })).toBeInTheDocument();
  });
});
