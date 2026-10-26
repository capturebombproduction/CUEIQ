// A queued master's upload no longer freezes the setlist builder (2026-10-27 desktop hunt;
// a regression of c4388cf's queue-behind).
//
// While a setlist snapshot waits in the desktop queue, every builder edit made ONLINE goes
// to enqueueMgmtOp - which runs under the SAME in-module lock a flush holds for its whole
// run (mgmt-outbox.ts withOutboxLock). The flush replayed in seq order, so an audio.upload
// queued BEFORE the setlist edit (a new master picked in the van, then the set adjusted)
// held that lock - and the snapshot behind it - for as long as the WAV took on venue wifi
// (audioUploadCapMs: >= 10 min). For all that time the add buttons stayed disabled and the
// row the Ar added did not appear, with the network fine. The flush now lands every
// non-audio op first (seq order kept inside each group): the snapshot goes in seconds, and
// the builder, finding nothing queued, writes online again.
// Here the long upload is stood in for by the flush's first read of that op hanging.
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
import { fingerprintChildRows } from "@/lib/mgmt-outbox";
import {
  clearMgmtOutbox,
  enqueueMgmtOp,
  flushMgmtOutbox,
  listMgmtConflicts,
  pendingMgmtOps,
} from "~/data/mgmt-outbox";
import type { SetlistItem } from "@/lib/types";

const EVENT_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const TENANT_ID = "cccccccc-3333-4333-8333-cccccccccccc";
const SONG_ID = "50000000-0000-4000-8000-000000000009";
const SONG_2 = "50000000-0000-4000-8000-00000000000a";

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

const A = "aaaaaaaa-0000-4000-8000-000000000001";

let supa: SupabaseFake;
let server: SetlistItem[];
let netDown = false;
let releaseUpload: (() => void) | null = null;

function table(call: RecordedCall) {
  if (netDown) return offline();
  if (call.verb === "select") return ok(server.map((r) => ({ ...r })));
  if (call.verb === "insert") {
    const v = call.values as SetlistItem;
    const row = { ...item("bbbbbbbb-0000-4000-8000-000000000001", v.sort_order, v.title ?? ""), ...v };
    server.push(row);
    return ok(row);
  }
  if (call.verb === "update") {
    const r = server.find((x) => x.id === call.eq.id);
    if (!r) return ok([]);
    Object.assign(r, call.values as object);
    return ok([{ id: r.id }]);
  }
  if (call.verb === "upsert") return ok(null);
  return ok([]);
}

const queuedMaster = (songId: string) =>
  enqueueMgmtOp({
    kind: "audio.upload",
    id: songId,
    tenantId: TENANT_ID,
    groupId: "g1",
    path: `${TENANT_ID}/songs/${songId}/new.wav`,
    fileName: "new.wav",
    contentType: "audio/wav",
    basePath: null,
    songTitle: "Encore",
  });

beforeEach(async () => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  supa.setTable("setlist_items", table);
  // the queued master's flush: its first read stands in for the minutes-long PUT
  supa.setTable(
    "songs",
    () =>
      new Promise((resolve) => {
        releaseUpload = () => resolve(offline());
      })
  );
  server = [item(A, 1, "Song A")];
  netDown = false;
  releaseUpload = null;
  await clearMgmtOutbox();
  registerMgmtQueueSink(enqueueMgmtOp);
  registerQueuedChildListReader(async (kind, eventId) =>
    (await pendingMgmtOps()).some((op) => op.kind === kind && op.id === eventId)
  );
});
afterEach(() => {
  releaseUpload?.();
  registerMgmtQueueSink(null);
  registerQueuedChildListReader(null);
});

describe("a queued master's upload and the setlist builder", () => {
  it("the row added with the network up appears while a queued master is still uploading", async () => {
    // in the van: a new master picked offline (queued first)…
    await queuedMaster(SONG_ID);
    render(
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
    // …then the set adjusted offline (queued second)
    netDown = true;
    const titles = screen.getAllByLabelText("ชื่อเพลง / หัวข้อ") as HTMLInputElement[];
    fireEvent.change(titles[0], { target: { value: "Song A (short)" } });
    await act(async () => {
      fireEvent.blur(titles[0]);
    });
    await waitFor(async () => expect(await pendingMgmtOps()).toHaveLength(2));

    // at the venue: wifi up, the flush starts (and ends up holding the lock on the master)
    netDown = false;
    const flushing = flushMgmtOutbox();
    await waitFor(() => expect(releaseUpload).toBeTruthy());
    // the snapshot landed before the upload began
    const landed = supa.callsTo("setlist_items", "upsert").map((c) => c.values as SetlistItem[]);
    expect(landed.map((rows) => rows.map((r) => r.title))).toEqual([["Song A (short)"]]);
    expect((await pendingMgmtOps()).map((op) => op.kind)).toEqual(["audio.upload"]);

    // the Ar adds the encore MC row - it is on screen within a moment
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /MC/ }));
    });
    await waitFor(() => expect(screen.getAllByLabelText("ชื่อเพลง / หัวข้อ")).toHaveLength(2), {
      timeout: 1500,
    });
    expect(server).toHaveLength(2); // written online, not queued behind the upload

    // the upload's own turn still comes: cut off here, it stays queued for the next flush
    await act(async () => {
      releaseUpload!();
      await flushing;
    });
    expect((await pendingMgmtOps()).map((op) => op.kind)).toEqual(["audio.upload"]);
  });

  it("uploads go after every other op, each group in the order it was queued", async () => {
    supa.setTable("songs", ok(null)); // both songs deleted online: each upload parks, in turn
    await queuedMaster(SONG_ID);
    await enqueueMgmtOp({
      kind: "setlist.upsert",
      id: EVENT_ID,
      tenantId: TENANT_ID,
      eventName: "Seishin @ Venue",
      rows: [{ ...server[0], title: "Song A (short)" }],
      base: fingerprintChildRows("setlist.upsert", server),
    });
    await queuedMaster(SONG_2);

    expect(await flushMgmtOutbox()).toMatchObject({ flushed: 1, parked: 2, remaining: 0 });

    const order = supa.calls
      .filter((c) => c.table === "songs" || (c.table === "setlist_items" && c.verb === "upsert"))
      .map((c) => (c.table === "songs" ? `songs:${String(c.eq.id)}` : "setlist"));
    expect(order).toEqual(["setlist", `songs:${SONG_ID}`, `songs:${SONG_2}`]);
    expect((await listMgmtConflicts()).map((c) => c.rec.op.id)).toEqual([SONG_ID, SONG_2]);
  });
});
