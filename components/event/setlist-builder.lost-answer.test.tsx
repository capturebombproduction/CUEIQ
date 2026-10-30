// An added row whose ANSWER is lost (2026-10-30, hunt 11). On venue Wi-Fi the insert can reach
// the server and the reply die on the way back (a phone hopping from Wi-Fi to cellular, an AP
// roam): supabase-js says "TypeError: Failed to fetch", status 0. The builder said
// "เพิ่มไม่สำเร็จ" and left the row off the screen; the user tapped again and the server held the
// song twice - which Live Mode, reading the server, then played twice. The insert now carries
// the id it was minted with and a reply-less failure reads that id back; the offline queue holds
// the SAME row, so a replay finds it already there. A write that got a real HTTP answer is
// judged exactly as before.
//
// Also here (calendar-3, same hunt): the Hard Out verdict needs a show start, as on the Summary.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import {
  makeSupabaseFake,
  makeSession,
  ok,
  fail,
  offline,
  type SupabaseFake,
  type RecordedCall,
} from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { toast } from "sonner";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import { registerMgmtQueueSink } from "@/lib/mgmt-write";
import { childFlushDecision, type ChildListOp, type NewMgmtOp } from "@/lib/mgmt-outbox";
import type { SetlistItem } from "@/lib/types";

const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const TENANT_ID = "tttttttt-1111-4111-8111-tttttttttttt";

function item(id: string, sort_order: number, title: string): SetlistItem {
  return {
    id,
    event_id: EVENT_ID,
    tenant_id: TENANT_ID,
    kind: "song",
    title,
    sort_order,
    duration_seconds: 200,
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

let supa: SupabaseFake;
let db: SetlistItem[];
/** what the next insert answers once it has landed (null = its real answer) */
let insertAnswer: ReturnType<typeof ok> | null;
let insertLands: boolean;
/** every read after the insert fails too (the net died outright) */
let readsDown: boolean;

function table(call: RecordedCall) {
  if (call.verb === "insert") {
    const values = call.values as Partial<SetlistItem>;
    const row = { ...item(values.id ?? "server-minted", 0, ""), ...values } as SetlistItem;
    if (insertLands) db.push(row);
    return insertAnswer ?? ok(row);
  }
  if (readsDown) return offline();
  const byId = call.filters.find((f) => f.op === "in" && f.column === "id");
  if (byId) return ok(db.filter((r) => (byId.value as string[]).includes(r.id)));
  return ok([...db].sort((a, b) => b.sort_order - a.sort_order));
}

const base = () => [item("r1", 1, "A"), item("r2", 2, "B")];

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  db = base();
  insertAnswer = null;
  insertLands = true;
  readsDown = false;
  supa.setTable("setlist_items", table);
});
afterEach(() => {
  registerMgmtQueueSink(null);
  cleanup();
});

function mount(opts: { showStartTime?: string | null; hardOutTime?: string | null } = {}) {
  return render(
    <ConfirmProvider>
      <SetlistBuilder
        eventId={EVENT_ID}
        tenantId={TENANT_ID}
        editable
        initialItems={base()}
        showStartTime={opts.showStartTime === undefined ? "19:00" : opts.showStartTime}
        hardOutTime={opts.hardOutTime ?? null}
        members={[]}
        songs={[]}
        eventName="Show"
      />
    </ConfirmProvider>
  );
}

const rowsOnScreen = () => screen.getAllByRole("textbox", { name: "ชื่อเพลง / หัวข้อ" }).length;
const insertedId = () =>
  (supa.callsTo("setlist_items", "insert")[0].values as { id?: string }).id;
const readBacks = () =>
  supa.callsTo("setlist_items", "select").filter((c) => c.filters.some((f) => f.op === "in"));

async function addSong() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^เพลง$/ }));
  });
  await waitFor(() => expect(screen.getByRole("button", { name: /^เพลง$/ })).not.toBeDisabled());
}

describe("setlist builder: a row whose insert answer was lost", () => {
  it("landed: the row is on screen once, no failure is reported, and a retap is never needed", async () => {
    insertAnswer = offline(); // the write lands, its answer is lost
    mount();
    await addSong();

    expect(insertedId(), "the insert carries its own id").toMatch(/^[0-9a-f-]{36}$/);
    expect(rowsOnScreen()).toBe(3);
    expect(db).toHaveLength(3);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("not landed: today's failure, unchanged (web)", async () => {
    insertAnswer = offline();
    insertLands = false;
    mount();
    await addSong();

    expect(readBacks()).toHaveLength(1);
    expect(rowsOnScreen()).toBe(2);
    expect(toast.error).toHaveBeenCalledWith("เพิ่มไม่สำเร็จ", expect.anything());
  });

  it("a real HTTP answer is believed as before: no read-back", async () => {
    insertAnswer = fail("new row violates row-level security policy", 403);
    insertLands = false;
    mount();
    await addSong();

    expect(readBacks()).toHaveLength(0);
    expect(rowsOnScreen()).toBe(2);
    expect(toast.error).toHaveBeenCalledWith("เพิ่มไม่สำเร็จ", expect.anything());
  });

  it("desktop, read-back impossible too: the queued row IS the row that landed, so the flush finds it applied", async () => {
    const queued: NewMgmtOp[] = [];
    registerMgmtQueueSink(async (op) => {
      queued.push(op);
    });
    insertAnswer = offline();
    // the write landed just before the wifi died: its answer and every read after it are lost
    supa.setTable("setlist_items", (call) => {
      const r = table(call);
      if (call.verb === "insert") readsDown = true;
      return r;
    });
    mount();
    await addSong();

    expect(queued).toHaveLength(1);
    const op = queued[0] as ChildListOp;
    expect((op.rows as SetlistItem[]).map((r) => r.id)).toContain(insertedId());
    expect(childFlushDecision(op, db)).toBe("already-applied");
  });
});

describe("setlist builder: the Hard Out verdict needs a show start", () => {
  it("no show start: no 'อยู่ในเวลา' claim counted from 00:00", () => {
    mount({ showStartTime: null, hardOutTime: "13:40" });
    expect(screen.queryByText(/อยู่ในเวลา/)).toBeNull();
    expect(screen.queryByText(/เกิน Hard Out/)).toBeNull();
  });

  it("with a show start the verdict is shown as before", () => {
    mount({ showStartTime: "13:00", hardOutTime: "13:40" });
    expect(screen.getByText(/อยู่ในเวลา/)).toBeTruthy();
  });
});
