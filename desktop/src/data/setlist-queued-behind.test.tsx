// Desktop, one Ar, no second person anywhere:
//   1. venue wifi is down → she sets song A to 3:00 → the write fails → the WHOLE setlist
//      is queued as one snapshot (base = the server list she started from);
//   2. the net is back but the snapshot has not flushed yet (MgmtSyncStatus flushes on
//      boot / 'online' / its timer / a click, and a venue AP that never dropped
//      navigator.onLine sends no 'online' at all) → she retitles song B;
//   3. the flush runs.
// Step 2 used to write straight to the server, so at step 3 the server no longer matched
// the snapshot's base - because of HER OWN write - and her step-1 edit was PARKED as
// "เวอร์ชันออนไลน์ถูกแก้ไขใหม่กว่าของเครื่องนี้". While a snapshot of the list is queued,
// later edits now join it (lib/mgmt-write tryQueueBehindPendingChildList; main.tsx
// registers the reader below) and the planner keeps the original base.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import {
  makeSession,
  makeSupabaseFake,
  ok,
  offline,
  type RecordedCall,
  type SupabaseFake,
} from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() },
  Toaster: () => null,
}));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import { registerMgmtQueueSink, registerQueuedChildListReader } from "@/lib/mgmt-write";
import type { ChildListOp } from "@/lib/mgmt-outbox";
import {
  clearMgmtOutbox,
  enqueueMgmtOp,
  flushMgmtOutbox,
  listMgmtConflicts,
  pendingMgmtOps,
} from "./mgmt-outbox";
import type { SetlistItem } from "@/lib/types";

const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const TENANT_ID = "cccccccc-3333-4333-8333-cccccccccccc";

function item(id: string, sort_order: number, title: string, duration: number): SetlistItem {
  return {
    id,
    event_id: EVENT_ID,
    tenant_id: TENANT_ID,
    kind: "song",
    title,
    sort_order,
    duration_seconds: duration,
    buffer_before_seconds: 0,
    buffer_after_seconds: 0,
    mic_slots: [],
    notes: null,
    song_id: null,
    audio_path: null,
    audio_name: null,
    loop_audio: false,
  };
}

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";

let supa: SupabaseFake;
let server: SetlistItem[];
let netDown = false;

/** A tiny stateful setlist_items table, enough for the editor's writes and the replay. */
function table(call: RecordedCall) {
  if (netDown) return offline();
  if (call.verb === "select") return ok(server.map((r) => ({ ...r })));
  if (call.verb === "update") {
    const r = server.find((x) => x.id === call.eq.id);
    if (!r) return ok([]);
    Object.assign(r, call.values as object);
    return ok([{ id: r.id }]);
  }
  if (call.verb === "upsert") {
    for (const v of call.values as SetlistItem[]) {
      const at = server.findIndex((x) => x.id === v.id);
      if (at >= 0) server[at] = { ...server[at], ...v };
      else server.push({ ...v });
    }
    return ok(null);
  }
  if (call.verb === "delete") {
    const keep = call.filters.find((f) => f.op === "not" && f.column === "id");
    const ids = keep ? String(keep.value).replace(/[()]/g, "").split(",") : [];
    server = server.filter((x) => ids.includes(x.id));
    return ok([]);
  }
  return ok([]);
}

beforeEach(async () => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  supa.setTable("setlist_items", table);
  server = [item(A, 1, "Song A", 200), item(B, 2, "Song B", 200)];
  netDown = false;
  await clearMgmtOutbox();
  registerMgmtQueueSink(enqueueMgmtOp);
  // exactly what desktop/src/main.tsx registers
  registerQueuedChildListReader(async (kind, eventId) =>
    (await pendingMgmtOps()).some((op) => op.kind === kind && op.id === eventId)
  );
});
afterEach(() => {
  registerMgmtQueueSink(null);
  registerQueuedChildListReader(null);
});

function mount() {
  return render(
    <ConfirmProvider>
      <SetlistBuilder
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        editable
        initialItems={server.map((r) => ({ ...r }))}
        showStartTime={null}
        hardOutTime={null}
        members={[]}
        songs={[]}
        eventName="Seishin @ Venue"
      />
    </ConfirmProvider>
  );
}

describe("desktop setlist: an offline snapshot, then an edit after the net came back", () => {
  it("both edits reach the server; nothing parks as someone else's conflict", async () => {
    const { container } = mount();

    // 1. offline: song A → 3:00
    netDown = true;
    const durA = container.querySelector<HTMLInputElement>(`#sl-${A}-dur`)!;
    fireEvent.change(durA, { target: { value: "3:00" } });
    fireEvent.blur(durA);
    await waitFor(async () => expect(await pendingMgmtOps()).toHaveLength(1));

    // 2. the net is back, the snapshot has not flushed yet: song B → "Song B (encore)"
    netDown = false;
    const titles = screen.getAllByLabelText("ชื่อเพลง / หัวข้อ") as HTMLInputElement[];
    fireEvent.change(titles[1], { target: { value: "Song B (encore)" } });
    await act(async () => {
      fireEvent.blur(titles[1]);
    });
    // it joined the queued snapshot - one op, both edits - instead of going online
    await waitFor(async () => {
      const ops = await pendingMgmtOps();
      expect(ops).toHaveLength(1);
      const rows = (ops[0] as ChildListOp).rows as SetlistItem[];
      expect(rows.find((r) => r.id === B)!.title).toBe("Song B (encore)");
      expect(rows.find((r) => r.id === A)!.duration_seconds).toBe(180);
    });
    expect(supa.callsTo("setlist_items", "update").filter((c) => c.eq.id === B)).toHaveLength(0);

    // 3. the flush runs
    const res = await flushMgmtOutbox();
    expect(res).toMatchObject({ flushed: 1, parked: 0 });
    expect((await listMgmtConflicts()).map((c) => c.rec.reason)).toEqual([]);
    expect(server.find((r) => r.id === A)!.duration_seconds).toBe(180);
    expect(server.find((r) => r.id === B)!.title).toBe("Song B (encore)");
  });

  it("with nothing queued an edit still writes straight to the server", async () => {
    mount();
    const titles = screen.getAllByLabelText("ชื่อเพลง / หัวข้อ") as HTMLInputElement[];
    fireEvent.change(titles[1], { target: { value: "Song B (encore)" } });
    await act(async () => {
      fireEvent.blur(titles[1]);
    });
    await waitFor(() => expect(server.find((r) => r.id === B)!.title).toBe("Song B (encore)"));
    expect(await pendingMgmtOps()).toEqual([]);
  });
});
