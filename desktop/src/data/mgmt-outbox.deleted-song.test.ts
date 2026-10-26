import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fail,
  makeSession,
  makeSupabaseFake,
  ok,
  type RecordedCall,
  type SupabaseFake,
} from "@/test/fakes/supabase";

// An offline setlist snapshot that links a library song which was deleted online
// meanwhile (a temp song purged by คลังเพลง, or a deliberate delete) could never land.
// The upsert hits setlist_items.song_id's FK (0012: references songs on delete set
// null - SET NULL only nulls rows already on the server, never a row being written),
// applyChildListOp parked it with the raw Postgres text, and "ใช้ของฉัน" re-sent the
// same rows into the same FK forever. The only button that cleared it was
// "ใช้ของออนไลน์" - which throws away EVERY offline edit of that setlist. The replay
// now lands those rows unlinked, the way setlist-builder's restoreSnapshot already did.

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import {
  clearMgmtOutbox,
  enqueueMgmtOp,
  flushMgmtOutbox,
  listMgmtConflicts,
  pendingMgmtOps,
  resolveMgmtConflict,
} from "./mgmt-outbox";
import { fingerprintChildRows } from "@/lib/mgmt-outbox";

const EVENT_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const TENANT_ID = "cccccccc-3333-4333-8333-cccccccccccc";
const GONE_SONG = "dddddddd-4444-4444-8444-dddddddddddd";
const LIVE_SONG = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";

const row = (id: string, title: string, sort: number, song_id: string | null) => ({
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
  song_id,
  audio_path: null,
  audio_name: null,
  loop_audio: false,
});

const OPENER = "aaaaaaaa-0000-4000-8000-000000000001";
const TEMP = "aaaaaaaa-0000-4000-8000-000000000002";
const KEPT = "aaaaaaaa-0000-4000-8000-000000000003";

/** What the server holds, and what the desktop last saw before going offline. */
const SERVER = [row(OPENER, "Opener", 1, null), row(KEPT, "Kept", 3, LIVE_SONG)];
/** Offline in the van: notes on the opener + a song picked from the CACHED library -
 *  a temporary song that คลังเพลง purged online in the meantime. */
const SNAPSHOT = [
  { ...SERVER[0], notes: "โปรย confetti" },
  row(TEMP, "Temp song", 2, GONE_SONG),
  SERVER[1],
];
const FK = {
  code: "23503",
  message:
    'insert or update on table "setlist_items" violates foreign key constraint "setlist_items_song_id_fkey"',
};

let supa: SupabaseFake;
let serverRows: typeof SERVER;
/** song ids the songs table still holds */
let songsAlive: string[];

const upserts = () => supa.callsTo("setlist_items", "upsert");
const upsertedRows = (c: RecordedCall) => c.values as { id: string; song_id: string | null }[];

beforeEach(async () => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  serverRows = SERVER;
  songsAlive = [LIVE_SONG];
  await clearMgmtOutbox();
  supa.setScript({
    setlist_items: (call) => {
      if (call.verb === "select") return ok(serverRows);
      if (call.verb === "upsert") {
        const rows = call.values as { song_id: string | null }[];
        return rows.some((r) => r.song_id && !songsAlive.includes(r.song_id)) ? fail(FK, 409) : ok(null);
      }
      return ok([]);
    },
    songs: (call) => {
      const ids = (call.filters.find((f) => f.op === "in" && f.column === "id")?.value ?? []) as string[];
      return ok(ids.filter((id) => songsAlive.includes(id)).map((id) => ({ id })));
    },
  });
  await enqueueMgmtOp({
    kind: "setlist.upsert",
    id: EVENT_ID,
    tenantId: TENANT_ID,
    eventName: "Show",
    rows: SNAPSHOT,
    base: fingerprintChildRows("setlist.upsert", SERVER),
  });
});

describe("setlist snapshot replay - a linked library song deleted online", () => {
  it("lands the offline edits with the dead link dropped and every live link kept", async () => {
    const res = await flushMgmtOutbox();
    expect(res, JSON.stringify((await listMgmtConflicts())[0]?.rec.reason)).toMatchObject({
      flushed: 1,
      parked: 0,
    });
    const landed = upsertedRows(upserts()[upserts().length - 1]);
    expect(landed.find((r) => r.id === TEMP)!.song_id).toBeNull();
    expect(landed.find((r) => r.id === KEPT)!.song_id).toBe(LIVE_SONG);
    expect(landed.map((r) => r.id)).toEqual([OPENER, TEMP, KEPT]);
  });

  it("'ใช้ของฉัน' on a parked snapshot also lands with the dead link dropped", async () => {
    // someone edited online meanwhile → the guard parks it; the person chooses ใช้ของฉัน
    serverRows = [{ ...SERVER[0], title: "Opener (online)" }, SERVER[1]];
    await flushMgmtOutbox();
    const [c] = await listMgmtConflicts();
    expect(c?.rec.reason).toBe("เวอร์ชันออนไลน์ถูกแก้ไขใหม่กว่าของเครื่องนี้");

    const out = await resolveMgmtConflict(c.key, "mine");
    expect(out).toEqual({ ok: true });
    expect(await listMgmtConflicts()).toEqual([]);
    const landed = upsertedRows(upserts()[upserts().length - 1]);
    expect(landed.find((r) => r.id === TEMP)!.song_id).toBeNull();
  });

  it("does not unlink on a songs read it cannot prove was signed - the op stays queued", async () => {
    supa.setTable("songs", () => {
      // the session dies with the read: an anon read is EMPTY with no error (RLS),
      // which would read as "every linked song is gone"
      supa.auth.setSession(null);
      return ok([]);
    });
    const res = await flushMgmtOutbox();
    expect(res).toMatchObject({ flushed: 0, parked: 0 });
    expect(await pendingMgmtOps()).toHaveLength(1);
    expect(upserts()).toHaveLength(1); // only the first, refused one
  });

  it("an FK that unlinking cannot clear parks in Thai, not with Postgres' sentence", async () => {
    songsAlive = [LIVE_SONG, GONE_SONG]; // every song is there - the EVENT is what went
    supa.setTable("setlist_items", (call: RecordedCall) =>
      call.verb === "select" ? ok(serverRows) : call.verb === "upsert" ? fail(FK, 409) : ok([])
    );
    const res = await flushMgmtOutbox();
    expect(res).toMatchObject({ flushed: 0, parked: 1 });
    const [c] = await listMgmtConflicts();
    expect(c.rec.reason).toMatch(/ถูกลบไปแล้วบนออนไลน์/);
    expect(c.rec.reason).not.toMatch(/foreign key/);
  });
});
