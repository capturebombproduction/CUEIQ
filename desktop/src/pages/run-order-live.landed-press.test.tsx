// A queued press the FLUSH landed stays in the offline copy (2026-10-27 hunt, showrun-2).
//
// 19ea761 lays every press the flush lands onto the desktop's offline copy
// (RUNSEQ_LANDED_EVENT, desktop/src/data/run-order.ts). But EventLiveCaller writes that
// copy again on every press that commits online, from its own idea of what the server
// holds - which learned a landed press only from the re-read that follows the flush. On
// venue wifi that lets the flush's writes through but drops the board's re-read, the
// next online press (a +1) wrote the copy back to BEFORE the landed จบ + ต่อไป: the act
// it ended was live again in the copy, and the board opened from it offline later
// offered that act as NOW.
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { makePerms } from "@/lib/permissions";
import { makeSession, makeSupabaseFake, offline, ok, type RecordedCall } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { flushRunSeqOutbox, listRunSeqOps } from "@/lib/run-order-outbox";

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
/** the flapping link: writes get through, the board's festival-wide re-read does not */
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

const cachedRows = () =>
  (JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "null") as { seqs: Row[] } | null)?.seqs ?? [];
const cachedStatuses = () => cachedRows().map((r) => `${r.id}:${r.status}`);
const base = { kind: "band", planned_start: null, planned_end: null, buffer_seconds: 0, linked_event_id: null, actual_end: null };

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  window.localStorage.clear();
  setOnline(true);
  boardReadsFail = false;
  server = [
    { ...base, id: "A", sort_order: 1, title: "วงเปิด", status: "live", actual_start: "2026-10-27T10:00:00.000Z", offset_min: 0 },
    { ...base, id: "B", sort_order: 2, title: "Seishin Kakumei", status: "pending", actual_start: null, offset_min: null },
  ];
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

describe("desktop คุมคิว Live — a landed press, then an online press, on a flapping link", () => {
  it("the offline copy keeps the press the flush landed", async () => {
    render(page());
    const nextKey = await screen.findByRole("button", { name: /จบ \+ ต่อไป · Seishin Kakumei/ });
    // outage: จบ + ต่อไป queues on this device
    setOnline(false);
    fireEvent.click(nextKey);
    await screen.findByText(/ค้างซิงค์ 2 รายการ/);

    // the link comes back half way: the shell's flush lands the press, the re-read fails
    boardReadsFail = true;
    setOnline(true);
    await act(async () => {
      await flushRunSeqOutbox();
    });
    expect(await listRunSeqOps()).toHaveLength(0);
    expect(server.map((r) => `${r.id}:${r.status}`)).toEqual(["A:done", "B:live"]);
    await waitFor(() => expect(cachedStatuses()).toEqual(["A:done", "B:live"]));

    // the operator nudges B +1 - it commits online and writes the copy again
    const before = server[1].offset_min as number;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /เลื่อนคิว \+1 นาที/ }));
    });
    await waitFor(() => expect(server[1].offset_min).toBe(before + 1));
    await waitFor(() => expect(cachedRows().find((r) => r.id === "B")?.offset_min).toBe(before + 1));
    // the copy still says A ended and B is on stage - with the +1 on it
    expect(cachedStatuses()).toEqual(["A:done", "B:live"]);
    expect(cachedRows().find((r) => r.id === "A")?.actual_end).toBe(server[0].actual_end);

    // ...so the board opened from it offline later has B on stage, not A
    cleanup();
    setOnline(false);
    render(page());
    await screen.findByText(/นี่คือคิวที่เครื่องนี้เก็บไว้ล่าสุด/);
    await screen.findByRole("button", { name: /จบงาน/ });
    expect(screen.queryByRole("button", { name: /จบ \+ ต่อไป · Seishin Kakumei/ })).toBeNull();
  });
});
