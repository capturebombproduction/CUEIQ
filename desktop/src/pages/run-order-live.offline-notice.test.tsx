// The "this is an offline copy" notice comes down once the board has re-read the server
// (2026-10-27 hunt, showrun-3).
//
// "ออฟไลน์ — นี่คือคิวที่เครื่องนี้เก็บไว้ล่าสุด อาจไม่ตรงกับที่เครื่องอื่นเห็น" was set once,
// at page load, and nothing ever cleared it. Opened during an outage, the board kept
// calling itself a stale copy for the rest of the show after the wifi was back and the
// caller was showing the server's rows. It now comes down on the caller's "read" (a
// refetch it applied) - and only on that: a press that got through a link which drops
// the board's re-read leaves every other row as the old copy had it.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
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
const NOTICE = /นี่คือคิวที่เครื่องนี้เก็บไว้ล่าสุด/;

type Row = Record<string, unknown> & { id: string };
let server: Row[];
/** a link that passes writes but drops the board's festival-wide read */
let boardReadsFail: boolean;

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

const base = { kind: "band", planned_start: null, planned_end: null, buffer_seconds: 0, linked_event_id: null };

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  window.localStorage.clear();
  boardReadsFail = false;
  server = [
    { ...base, id: "A", sort_order: 1, title: "วงเปิด", status: "done", actual_start: "2026-10-27T10:00:00.000Z", actual_end: "2026-10-27T10:30:00.000Z", offset_min: 0 },
    { ...base, id: "B", sort_order: 2, title: "Seishin Kakumei", status: "live", actual_start: "2026-10-27T10:30:00.000Z", actual_end: null, offset_min: 0 },
  ];
  // this machine's last copy: A still on stage
  window.localStorage.setItem(
    CACHE_KEY,
    JSON.stringify({
      name: "A Lot Of Tone Fest",
      date: "2026-10-27",
      tenantId: TENANT,
      seqs: [
        { ...server[0], status: "live", actual_end: null },
        { ...server[1], status: "pending", actual_start: null, offset_min: null },
      ],
    })
  );
  const supa = makeSupabaseFake({ session: makeSession() });
  supa.setTable("events", ok({ id: EVENT_ID, name: "A Lot Of Tone Fest", event_date: "2026-10-27" }));
  supa.setTable("run_sequence", (call: RecordedCall) => {
    if (!navigator.onLine) return offline();
    if (call.verb === "select" && boardReadsFail && "tenant_id" in call.eq) return offline();
    const hit = server.filter((r) =>
      call.filters.every((f) =>
        f.op === "eq" && f.column in r
          ? r[f.column] === f.value
          : f.op === "is" && f.column in r
            ? r[f.column] == null
            : true
      )
    );
    if (call.verb === "update") {
      for (const r of hit) Object.assign(r, call.values as object);
      return ok(hit.map((r) => ({ id: r.id })));
    }
    return ok(hit.map((r) => ({ ...r })));
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

describe("desktop คุมคิว Live — the offline-copy notice", () => {
  it("goes away once the wifi is back and the board has re-read the server", async () => {
    setOnline(false);
    render(page());
    await screen.findByText(NOTICE);
    await screen.findByRole("button", { name: /จบ \+ ต่อไป · Seishin Kakumei/ }); // the copy: A on stage

    // the venue wifi comes back: the caller re-reads on 'online'
    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    // the board shows the server now (B on stage)...
    await screen.findByRole("button", { name: /จบงาน/ });
    // ...so it no longer claims to be a stale offline copy
    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
  });

  it("(control) stays up while the re-read fails, even when a press gets through", async () => {
    // the board is opened offline from the copy, A on stage as far as it knows
    server[0] = { ...server[0], status: "live", actual_end: null };
    server[1] = { ...server[1], status: "pending", actual_start: null, offset_min: null };
    setOnline(false);
    render(page());
    await screen.findByText(NOTICE);

    // the link passes writes but drops the board's re-read
    boardReadsFail = true;
    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /เลื่อนคิว \+1 นาที/ }));
    });
    await waitFor(() => expect(server[0].offset_min).toBe(1)); // committed
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });
});
