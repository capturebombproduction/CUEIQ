import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

// An edit merged into a setlist snapshot WHILE that snapshot was being written (2026-10-26,
// ตาที่ 3). Inside one window the outbox lock serialises that (the enqueue waits for the
// flush, then starts a fresh op on the acked base) - but another window sharing this
// IndexedDB merges straight into the record, and the planner keeps an op's ORIGINAL base
// on a merge. The flush deletes only the rev it applied, so the merged edit stayed queued
// with the PRE-flush base; the next flush found this device's own rows on the server, not
// that base, and parked her edit as "เวอร์ชันออนไลน์ถูกแก้ไขใหม่กว่าของเครื่องนี้".

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { clearMgmtOutbox, enqueueMgmtOp, flushMgmtOutbox, listMgmtConflicts, pendingMgmtOps } from "./mgmt-outbox";
import { fingerprintChildRows } from "@/lib/mgmt-outbox";

const EVENT_ID = "bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb";
const TENANT_ID = "cccccccc-3333-4333-8333-cccccccccccc";
const A = "aaaaaaaa-1111-4111-8111-000000000001";
const B = "aaaaaaaa-1111-4111-8111-000000000002";

const row = (id: string, title: string, sort: number) => ({
  id,
  tenant_id: TENANT_ID,
  event_id: EVENT_ID,
  kind: "song",
  title,
  duration_seconds: 200,
  buffer_before_seconds: 0,
  buffer_after_seconds: 0,
  mic_slots: [],
  notes: null as string | null,
  sort_order: sort,
  song_id: null,
  audio_path: null,
  audio_name: null,
  loop_audio: false,
});

const B0 = [row(A, "Opener", 1), row(B, "Closer", 2)]; // the server, before the van
const R1 = [row(A, "Opener (acoustic)", 1), row(B, "Closer", 2)]; // queued offline
const R2 = [row(A, "Opener (acoustic)", 1), row(B, "Closer (encore)", 2)]; // typed during the flush

/** A coalescing put made by ANOTHER window: straight into IndexedDB, no outbox lock. */
function mergeFromAnotherWindow(rows: typeof B0): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("cueiq-mgmt-outbox");
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("ops", "readwrite");
      const store = tx.objectStore("ops");
      const cur = store.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        const rec = c.value as { op: Record<string, unknown>; rev?: number };
        c.update({ ...rec, op: { ...rec.op, rows }, rev: (rec.rev ?? 0) + 1 });
      };
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
let server: ReturnType<typeof row>[];
let duringUpsert: (() => Promise<void>) | null;

const snapshot = (rows: typeof B0, base: typeof B0) => ({
  kind: "setlist.upsert" as const,
  id: EVENT_ID,
  tenantId: TENANT_ID,
  eventName: "Show",
  rows,
  base: fingerprintChildRows("setlist.upsert", base),
});

beforeEach(async () => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  server = B0.map((r) => ({ ...r }));
  duringUpsert = null;
  await clearMgmtOutbox();
  supa.setScript({
    setlist_items: async (call) => {
      if (call.verb === "select") return ok(server.map((r) => ({ ...r })));
      if (call.verb === "upsert") {
        const hook = duringUpsert;
        duringUpsert = null;
        if (hook) await hook(); // she types while the write is on the wire
        for (const v of call.values as typeof B0) {
          const at = server.findIndex((x) => x.id === v.id);
          if (at >= 0) server[at] = { ...server[at], ...v };
          else server.push({ ...v });
        }
        return ok(null);
      }
      return ok([]);
    },
  });
});

describe("desktop mgmt outbox - an edit merged while its snapshot was being written", () => {
  it("lands on the next flush instead of parking as someone else's change", async () => {
    await enqueueMgmtOp(snapshot(R1, B0));
    // another window's coalescing put lands while the write is on the wire: R2 merged
    // into the record (rev bumped), its base still B0 - what planEnqueue keeps
    duringUpsert = () => mergeFromAnotherWindow(R2);

    await flushMgmtOutbox();
    expect(server.map((r) => r.title)).toEqual(["Opener (acoustic)", "Closer"]);
    expect(await pendingMgmtOps()).toHaveLength(1); // the merged edit is still queued

    const res = await flushMgmtOutbox();
    expect((await listMgmtConflicts()).map((c) => c.rec.reason)).toEqual([]);
    expect(res).toMatchObject({ flushed: 1, parked: 0 });
    expect(server.map((r) => r.title)).toEqual(["Opener (acoustic)", "Closer (encore)"]);
  });
});
