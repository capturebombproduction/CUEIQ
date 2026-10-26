import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

// 2026-10-27 desktop hunt: a deliberate sign-out wipes this outbox (App.tsx SIGNED_OUT →
// clearMgmtOutbox), after the sign-out button warned "จะทิ้งทั้งหมด". A queued offline audio
// upload is TWO things: the op, and the take's bytes kept as the song's LOCAL SOURCE
// (lib/mgmt-write.ts tryQueueAudioUpload) - and Live Mode / practice read getLocalSource
// FIRST. The wipe dropped only the op, so this machine (the PA laptop) kept playing the
// discarded take at every later show, for every account, while every other device played
// the master. Pinned: discarding a queued upload - queued or parked - drops its override,
// as "ใช้ของออนไลน์" and dropPendingAudioUploadOp already did; an override picked with
// "ใช้ไฟล์ในเครื่องนี้" (no op behind it) is the operator's own choice and stays.

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import {
  clearMgmtOutbox,
  enqueueMgmtOp,
  flushMgmtOutbox,
  listMgmtConflicts,
  pendingMgmtCount,
} from "./mgmt-outbox";
import { getLocalSource, setLocalSource } from "@/lib/local-source";

const STORED = "sb-kewyqqxohckurwuepucv-auth-token";
const A = "11111111-1111-4111-8111-111111111111"; // = makeSession()'s user
const SONG = "5a5a5a5a-0000-4000-8000-000000000001";
const PICKED = "5a5a5a5a-0000-4000-8000-000000000002";

let supa: SupabaseFake;

const take = () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });

/** tryQueueAudioUpload's order: bytes first, then the op. */
async function queueOfflineUpload(songId: string): Promise<void> {
  await setLocalSource(songId, take(), "new-take.wav");
  await enqueueMgmtOp({
    kind: "audio.upload",
    id: songId,
    tenantId: "t",
    groupId: "g",
    path: `t/g/${songId}/new-take.wav`,
    fileName: "new-take.wav",
    contentType: "audio/wav",
    basePath: "t/g/old-master.wav",
    songTitle: "Song",
  });
}

beforeEach(async () => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  window.localStorage.clear();
  window.localStorage.setItem(STORED, JSON.stringify({ refresh_token: "r", user: { id: A } }));
  await clearMgmtOutbox();
});

describe("a deliberate sign-out vs a queued audio upload's local source", () => {
  it("drops the override of an upload that was still queued", async () => {
    await queueOfflineUpload(SONG);
    expect(await pendingMgmtCount()).toBe(1);

    await clearMgmtOutbox();

    expect(await pendingMgmtCount()).toBe(0);
    expect(await getLocalSource(SONG)).toBeNull();
  });

  it("drops the override of an upload that had parked as a conflict", async () => {
    await queueOfflineUpload(SONG);
    // the song was deleted online meanwhile: the flush parks the upload, bytes kept
    supa.setTable("songs", ok(null));
    await flushMgmtOutbox();
    expect(await listMgmtConflicts()).toHaveLength(1);
    expect(await getLocalSource(SONG)).not.toBeNull();

    await clearMgmtOutbox();

    expect(await listMgmtConflicts()).toHaveLength(0);
    expect(await getLocalSource(SONG)).toBeNull();
  });

  it("control: leaves an override that no queued upload stands behind ('ใช้ไฟล์ในเครื่องนี้')", async () => {
    await setLocalSource(PICKED, take(), "picked-here.wav");
    await queueOfflineUpload(SONG);

    await clearMgmtOutbox();

    expect(await pendingMgmtCount()).toBe(0);
    expect((await getLocalSource(PICKED))?.name).toBe("picked-here.wav");
  });
});
