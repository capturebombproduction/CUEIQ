// Durable offline queue for desktop MANAGEMENT writes (⭐#1 step 2 — design in
// docs/desktop-offline-management.md). Mirrors lib/show-run-outbox.ts (IndexedDB,
// best-effort, stop-at-first-network-failure) but management data is the
// "ONLINE WINS" conflict zone: a queued edit only applies on reconnect if the
// server row hasn't advanced past the value it was edited against — otherwise it's
// PARKED in a conflicts store for the user to resolve (keep mine / keep server).
// Nothing is ever silently dropped.
//
// Desktop-only: the web build never imports this file (web stays online-mgmt).
// All decision logic is pure + unit-tested in lib/mgmt-outbox.ts; this file is the
// thin I/O around it.
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import {
  CHILD_TABLES,
  CHILD_WRITE_COLUMNS,
  childFlushDecision,
  eventPatchApplied,
  isApprovalGuardError,
  isAudioUploadOp,
  isChildListOp,
  isQueueableWriteError,
  isUniqueViolation,
  MGMT_OUTBOX_EVENT,
  nextOpRev,
  planEnqueue,
  shouldApplyOnFlush,
  type ChildListOp,
  type MgmtOp,
  type NewMgmtOp,
} from "@/lib/mgmt-outbox";
import {
  audioConflictReason,
  audioFlushDecision,
  type AudioUploadOp,
} from "@/lib/audio-upload-queue";
import { removeEventAudio, uploadEventAudio } from "@/lib/audio-remote";
import { privateChannel, songsTopic } from "@/lib/realtime";
import { clearLocalSource, getLocalSource } from "@/lib/local-source";
import { cacheSongBlob } from "@/lib/song-cache";
import { hasLiveSession } from "@/lib/auth-session";
import { wroteNothing } from "@/lib/write-guard";
import { getStoredSessionUser } from "~/data/stored-session";

const DB_NAME = "cueiq-mgmt-outbox";
const OPS = "ops";
const CONFLICTS = "conflicts";

/** Fired after any queue change so the shell's status chips can refresh.
 *  Defined in the shared core so shared components can listen without importing
 *  this desktop-only module; re-exported here because every caller reaches for it
 *  next to the store it belongs to. */
export { MGMT_OUTBOX_EVENT };

interface OpRec {
  op: NewMgmtOp;
  /** Owner check on a shared band device: never flush/overlay another account's ops. */
  userId: string | null;
  queuedAt: number;
  /** Bumped on every coalescing put — the flush deletes a record only at the rev it applied. */
  rev?: number;
}

// All queue mutations (enqueue / flush / resolve) run through this promise chain so
// a flush's read→apply→delete can never interleave with a coalescing enqueue
// (which puts onto the SAME IndexedDB key the flush is about to delete).
let outboxLock: Promise<unknown> = Promise.resolve();
/** Bumped by clearMgmtOutbox (sign-out) — a flush in flight checks it and stops. */
let outboxGeneration = 0;
function withOutboxLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = outboxLock.then(fn, fn);
  outboxLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * updated_at (epoch ms) our own flush last wrote per event id. When a later edit
 * for the same event is queued after that flush, the online-wins guard would see
 * "server advanced past base" — but the advance was OUR write, so it must apply,
 * not park a false conflict. Session-local by design (lost on restart — the
 * eventPatchApplied idempotence check covers the crash-replay case instead).
 */
const selfWriteMs = new Map<string, number>();

export interface ConflictRec extends OpRec {
  parkedAt: number;
  reason: string;
}

function notify(): void {
  try {
    window.dispatchEvent(new Event(MGMT_OUTBOX_EVENT));
  } catch {
    /* non-DOM context */
  }
}

function currentUserId(): string | null {
  return getStoredSessionUser()?.id ?? null;
}

/**
 * Same check for the flush path, as a throw: the loop already treats a throw as
 * "not now — leave the whole queue alone and retry on the next reconnect", which
 * is exactly right here. A queued op is always recoverable; a parked-or-deleted
 * one may not be.
 */
async function requireLiveSession(): Promise<void> {
  if (!(await hasLiveSession())) throw new Error("mgmt-outbox: no live session");
}

/** Thai reason for a resolve we couldn't even attempt as the signed-in user. */
const NO_SESSION_REASON =
  "ยังยืนยันบัญชีกับเซิร์ฟเวอร์ไม่ได้ — ยังไม่ได้เขียนทับ ลองใหม่อีกครั้งในสักครู่";

/** Thai reason for a DELETE the server accepted while removing no row — with a
 *  proven live session that means it was refused (no right to delete) rather than
 *  already done, and the op must stay visible instead of counting as synced. */
const DELETE_NO_ROWS_REASON =
  "ลบงานนี้บนออนไลน์ไม่สำเร็จ — เซิร์ฟเวอร์ไม่ได้ลบให้ (อาจไม่มีสิทธิ์ลบ) ลองใหม่อีกครั้ง";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      // autoIncrement keys are monotonic per store → the key IS the op's seq.
      if (!db.objectStoreNames.contains(OPS)) db.createObjectStore(OPS, { autoIncrement: true });
      if (!db.objectStoreNames.contains(CONFLICTS))
        db.createObjectStore(CONFLICTS, { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * IndexedDB fires ONLY 'abort' when a transaction fails to commit (quota — the
 * cached show audio shares this origin's budget); the request-level 'error' never
 * arrives. A promise that settles on 'error' alone would then hang forever, and
 * every one of these runs inside the outbox lock — a hang there wedges enqueue and
 * flush for the rest of the session. So every readwrite tx below settles on both.
 * (The same rule now covers every other IndexedDB store in the app through the
 * shared lib/idb-tx.ts helper; this local one predates it and stays as-is because
 * its call sites all assign tx.onerror first.)
 */
function settleOnAbort(tx: IDBTransaction): void {
  tx.onabort = tx.onerror;
}

function listStore<T>(store: string): Promise<{ key: number; rec: T }[]> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const out: { key: number; rec: T }[] = [];
        const req = tx.objectStore(store).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            out.push({ key: Number(cursor.key), rec: cursor.value as T });
            cursor.continue();
          } else {
            db.close();
            resolve(out);
          }
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
        // Readonly, but the same abort rule applies: this one is awaited INSIDE the
        // outbox lock, so a transaction that dies without a request error would
        // wedge every enqueue and flush behind it.
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
}

function deleteFrom(store: string, key: number): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          resolve();
        };
        settleOnAbort(tx);
      })
  );
}

async function listMyOps(): Promise<{ key: number; rec: OpRec }[]> {
  const uid = currentUserId();
  const all = await listStore<OpRec>(OPS);
  return all.filter((r) => r.rec.userId === uid).sort((a, b) => a.key - b.key);
}

/** Queue a management write (coalescing per event — see lib planEnqueue). */
export async function enqueueMgmtOp(op: NewMgmtOp): Promise<void> {
  await withOutboxLock(async () => {
    const userId = currentUserId();
    const mine = await listMyOps();
    const plan = planEnqueue(
      mine.map((r) => ({ ...r.rec.op, seq: r.key }) as MgmtOp),
      op
    );
    const prev = plan.replaceSeq != null ? mine.find((r) => r.key === plan.replaceSeq) : undefined;
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OPS, "readwrite");
      const store = tx.objectStore(OPS);
      for (const seq of plan.dropSeqs) store.delete(seq);
      if (plan.op) {
        const rec: OpRec = {
          op: plan.op,
          userId,
          queuedAt: Date.now(),
          rev: nextOpRev(prev?.rec.rev),
        };
        if (plan.replaceSeq != null) store.put(rec, plan.replaceSeq);
        else store.add(rec);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      settleOnAbort(tx);
    });
  });
  notify();
}

/**
 * Post-apply delete for the flush: remove the record at `key` ONLY if it still
 * holds the rev that was applied. A coalescing put that landed since (another
 * window/instance sharing this IndexedDB) bumps `rev` — that merged, never-applied
 * edit must stay queued, not be silently destroyed.
 */
function deleteOpIfRevMatches(key: number, rev: number): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve) => {
        const tx = db.transaction(OPS, "readwrite");
        const store = tx.objectStore(OPS);
        const get = store.get(key);
        get.onsuccess = () => {
          const rec = get.result as OpRec | undefined;
          if (rec && (rec.rev ?? 0) === rev) store.delete(key);
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          resolve();
        };
        settleOnAbort(tx);
      })
  );
}

/** Current user's pending ops, seq order — the loaders' overlay input. */
export async function pendingMgmtOps(): Promise<MgmtOp[]> {
  try {
    const mine = await listMyOps();
    return mine.map((r) => ({ ...r.rec.op, seq: r.key }) as MgmtOp);
  } catch {
    return [];
  }
}

export async function pendingMgmtCount(): Promise<number> {
  return (await pendingMgmtOps()).length;
}

/**
 * songIds whose audio is still sitting on this device waiting to be pushed
 * (⭐#1 step 6) — what the Library badges as "รออัปโหลด". Parked conflicts are
 * deliberately excluded: those are not waiting for the network, they are waiting
 * for a person, and the shell's "ชนกัน" chip is where that lives.
 */
export async function pendingAudioSongIds(): Promise<Set<string>> {
  const ops = await pendingMgmtOps().catch(() => [] as MgmtOp[]);
  return new Set(ops.filter(isAudioUploadOp).map((op) => op.id));
}

/**
 * Forget a queued upload for `songId` — the op AND the local bytes it points at.
 * Used when a later real upload supersedes it: leaving the local-source override
 * behind would make THIS machine (often the one wired to the PA) keep playing the
 * old take while every other device has the new master.
 */
export async function dropPendingAudioUploadOp(songId: string): Promise<void> {
  await withOutboxLock(async () => {
    const mine = await listMyOps().catch(() => [] as { key: number; rec: OpRec }[]);
    for (const { key, rec } of mine) {
      if (isAudioUploadOp(rec.op) && rec.op.id === songId) await deleteFrom(OPS, key);
    }
  });
  await clearLocalSource(songId).catch(() => {});
  notify();
}

/** Current user's parked conflicts (with their store keys, for resolution). */
export async function listMgmtConflicts(): Promise<{ key: number; rec: ConflictRec }[]> {
  try {
    const uid = currentUserId();
    const all = await listStore<ConflictRec>(CONFLICTS);
    return all.filter((r) => r.rec.userId === uid).sort((a, b) => a.key - b.key);
  } catch {
    return [];
  }
}

/**
 * Move a rejected op into the conflicts store. Returns TRUE only when the row is
 * PROVEN persisted (tx.oncomplete — IndexedDB rolls the whole transaction back on
 * error/abort, so nothing else counts): the caller deletes the queued op right
 * after, and a swallowed quota failure here would destroy the venue's offline edit
 * with no error and no conflict panel. This product has no undo.
 */
async function parkConflict(rec: OpRec, reason: string): Promise<boolean> {
  try {
    const db = await openDB();
    return await new Promise<boolean>((resolve) => {
      const tx = db.transaction(CONFLICTS, "readwrite");
      tx.objectStore(CONFLICTS).add({ ...rec, parkedAt: Date.now(), reason } satisfies ConflictRec);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
      settleOnAbort(tx);
    });
  } catch {
    return false; // couldn't even open the DB — the op must stay queued
  }
}

/** Thai reason for a unique-index collision the replay itself can't resolve. */
const DUPLICATE_ROW_REASON =
  "มีรายการซ้ำที่ระบบไม่อนุญาต (เช่น รอบถ่ายรูปซ้ำในงานเดียว) — แก้รายการนี้บนออนไลน์แล้วลองใหม่";

/** Thai reason for migration 0037's approval guard refusing the queued status. */
const APPROVAL_REASON = "สถานะ “อนุมัติแล้ว” ต้องให้สตาฟที่มีสิทธิ์เป็นคนอนุมัติ";

/**
 * Classify one failed write during a flush: still-offline throws, rejection parks.
 *
 * `status` is the PostgrestResponse's HTTP status, passed at every site that has a
 * response in scope. Round 10 taught the ENQUEUE side that a 5xx/429 is transient;
 * this side had been left classifying by prose, and prose is exactly what a sick
 * server doesn't give you — a Supabase/Cloudflare 503 arrives as an HTML error page
 * that postgrest-js puts into `error.message` verbatim, matching none of the network
 * words. That read as a REAL REJECTION, so a venue edit the user had correctly
 * queued got PARKED (and deleted from the queue) with a raw HTML page as its Thai
 * reason — and "ใช้ของออนไลน์" then threw the edit away. With the status it throws
 * instead, which the flush loop treats as "not now": the op stays queued for the
 * next reconnect. See lib/mgmt-outbox.ts isQueueableWriteError for what a status
 * does and does not decide.
 */
function failOrThrow(
  message: string,
  onLine: boolean,
  status?: number | null
): { conflict: string } {
  if (isQueueableWriteError(message, onLine, status)) throw new Error(message);
  return { conflict: message };
}

/**
 * Land one child-list snapshot (⭐#1 step 5): a guarded REPLACE-SET on the event's
 * rows in that table. Upsert the snapshot rows FIRST, then delete the rows the
 * snapshot no longer contains — crash-safe (no window where the data is gone) and
 * idempotent (a re-run upserts no-ops and re-deletes nothing). `force` skips the
 * online-wins guard (the user chose "ใช้ของฉัน" on a parked conflict).
 */
async function applyChildListOp(
  op: ChildListOp,
  onLine: boolean,
  force: boolean
): Promise<"applied" | { conflict: string }> {
  const supabase = createClient();
  const table = CHILD_TABLES[op.kind];
  const isLineup = op.kind === "lineup.upsert";

  if (!force) {
    // Online-wins guard: no updated_at on the child tables, so compare the
    // server's current rows (fingerprinted) against the rows this edit was based
    // on. See childFlushDecision for the already-applied re-run shortcut.
    const sel =
      op.kind === "lineup.upsert" ? "member_id" : CHILD_WRITE_COLUMNS[op.kind].join(",");
    const { data, error, status } = await supabase.from(table).select(sel).eq("event_id", op.id);
    if (error) return failOrThrow(error.message, onLine, status);
    // An anon read comes back EMPTY with no error (RLS) — which fingerprints as
    // "the online list changed" (park a false conflict) or, for a snapshot that
    // clears the list, as "already applied" (drop the op). Both would throw away
    // real venue work, so only interpret rows we can prove carried our JWT.
    await requireLiveSession();
    const serverRows = isLineup
      ? ((data ?? []) as unknown as { member_id: string }[]).map((r) => r.member_id)
      : ((data ?? []) as unknown[]);
    const decision = childFlushDecision(op, serverRows);
    if (decision === "already-applied") return "applied";
    if (decision === "conflict") {
      return { conflict: "เวอร์ชันออนไลน์ถูกแก้ไขใหม่กว่าของเครื่องนี้" };
    }
  }

  if (isLineup) {
    const memberIds = op.rows as string[];
    if (memberIds.length) {
      const { error, status } = await supabase.from(table).upsert(
        memberIds.map((member_id) => ({
          tenant_id: op.tenantId,
          event_id: op.id,
          member_id,
        })),
        { onConflict: "event_id,member_id", ignoreDuplicates: true }
      );
      if (error) return failOrThrow(error.message, onLine, status);
    }
    // write-guard-exempt: a replace-set delete ("drop the members my snapshot no
    // longer lists") legitimately matches 0 rows, so there is nothing for a row
    // count to prove. The anon case this file guards elsewhere is already covered
    // upstream — requireLiveSession() before the guard read, or hasLiveSession() at
    // the top of resolveConflict on the force path.
    let del = supabase.from(table).delete().eq("event_id", op.id);
    if (memberIds.length) del = del.not("member_id", "in", `(${memberIds.join(",")})`);
    const { error, status } = await del;
    if (error) return failOrThrow(error.message, onLine, status);
    return "applied";
  }

  const rows = op.rows as Record<string, unknown>[];
  // Carries the failing response's HTTP status out with its message — a 5xx here is
  // as transient as anywhere else, and the caller can't classify it without one.
  const deleteRemoved = async (): Promise<{ message: string; status: number } | null> => {
    // write-guard-exempt: same replace-set shape as the lineup branch — 0 rows
    // removed is the normal outcome when the snapshot dropped nothing.
    let del = supabase.from(table).delete().eq("event_id", op.id);
    if (rows.length) del = del.not("id", "in", `(${rows.map((r) => r.id).join(",")})`);
    const { error, status } = await del;
    return error ? { message: error.message, status } : null;
  };
  if (rows.length) {
    let up = await supabase.from(table).upsert(rows);
    if (up.error && isUniqueViolation(up.error.code, up.error.message)) {
      // one-photo-per-event (mig 0036): an offline delete+re-add mints a fresh row
      // id, so the server's stale photo row blocks the upsert. Clear the rows the
      // snapshot no longer contains FIRST, then retry once (the delete below then
      // re-runs as a no-op).
      const delFail = await deleteRemoved();
      if (delFail) return failOrThrow(delFail.message, onLine, delFail.status);
      up = await supabase.from(table).upsert(rows);
      if (up.error && isUniqueViolation(up.error.code, up.error.message)) {
        // Still colliding → the two rows sit INSIDE this snapshot (one row gives up
        // kind='photo' while another takes it), so no upsert order clears the index.
        // Replace the whole set instead: drop the event's rows, insert mine.
        // write-guard-exempt: the insert that follows is what has to land, and it
        // reports its own error — a row count on the wipe would add nothing.
        const wipe = await supabase.from(table).delete().eq("event_id", op.id);
        if (wipe.error) return failOrThrow(wipe.error.message, onLine, wipe.status);
        up = await supabase.from(table).insert(rows);
      }
      if (up.error) {
        // This recovery path already deleted rows, so the "upsert first, delete
        // after" crash-safety of the happy path no longer holds — put the snapshot
        // back (best-effort) before parking, or the server keeps a half-emptied list.
        await supabase.from(table).upsert(rows);
        const dup = isUniqueViolation(up.error.code, up.error.message);
        return failOrThrow(dup ? DUPLICATE_ROW_REASON : up.error.message, onLine, up.status);
      }
    } else if (up.error) {
      return failOrThrow(up.error.message, onLine, up.status);
    }
  }
  const delFail = await deleteRemoved();
  if (delFail) return failOrThrow(delFail.message, onLine, delFail.status);
  return "applied";
}

/**
 * How long a queued master may hold the outbox lock. Deliberately generous — a
 * 27–88 MB WAV over venue wifi legitimately takes minutes — but finite, because
 * the alternative is a lock nobody ever gets back. Timing out is RETRYABLE: the op
 * stays queued and the next reconnect tries again.
 */
const AUDIO_UPLOAD_TIMEOUT_MS = 10 * 60_000;

/**
 * Tell any open Live Mode (same band) that a song's audio changed, so it
 * re-resolves in real time — the same broadcast the ONLINE library replace does
 * (components/song/song-library.tsx's broadcastSongsChanged). The flush and
 * force-replay paths below land the identical replace+delete but, unlike the
 * online path, had no channel to broadcast on: a device with Live Mode open kept
 * the stale audio_path whose object removeEventAudio(op.basePath) had just
 * deleted, and the presign 404s the next time that song is cued.
 *
 * createClient() is a module-level SINGLETON (that's the point of the desktop
 * localStorage-backed client), and RealtimeClient.channel(topic) hands back an
 * EXISTING channel for that topic instead of opening a second one. Live Mode
 * holds exactly this topic for as long as it's mounted, so naively calling
 * subscribe() here would join a channel that's ALREADY SUBSCRIBED — and
 * RealtimeChannel.subscribe() only runs its join callback (where the send()
 * below lives) when the channel is CLOSED. On an open channel it is a same-tick
 * no-op: the "SUBSCRIBED" branch never fires and the broadcast silently vanishes
 * with no error anywhere. So: reuse an already-open channel directly, and only
 * create+subscribe+tear down a channel of our own when none exists yet. A
 * channel we created is removed on every terminal status, not just SUBSCRIBED —
 * an errored/timed-out join still holds the topic and must not leak it for the
 * rest of the session.
 */
function broadcastAudioChanged(groupId: string): void {
  const supabase = createClient();
  const topic = songsTopic(groupId);
  // RealtimeClient stores channels under a "realtime:" prefixed topic — see
  // RealtimeClient.channel() in @supabase/realtime-js.
  const existing = supabase.getChannels().find((c) => c.topic === `realtime:${topic}`);
  if (existing) {
    // Someone else (Live Mode) owns this channel's lifecycle — send on it as-is
    // and never remove a channel we didn't create.
    existing.send({ type: "broadcast", event: "changed", payload: {} });
    return;
  }
  const ch = privateChannel(supabase, topic);
  ch.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      ch.send({ type: "broadcast", event: "changed", payload: {} });
      setTimeout(() => supabase.removeChannel(ch), 600);
    } else if (
      status === "CHANNEL_ERROR" ||
      status === "TIMED_OUT" ||
      status === "CLOSED"
    ) {
      // Never reached SUBSCRIBED (or the socket dropped it) — remove it here or
      // this channel, and the topic it holds, leaks for the rest of the session.
      supabase.removeChannel(ch);
    }
  });
}

/**
 * ⭐#1 step 6 — push an audio file that was picked while this device was offline.
 *
 * The bytes are the song's LOCAL SOURCE (lib/local-source.ts): the same blob this
 * device has been playing since it was picked, so a successful flush is really
 * just "make what I'm already hearing the master everyone gets". That is why the
 * tail mirrors the Library's own pushLocalAsMaster — cache the blob under its new
 * key, sweep the file it replaced, then drop the override so playback falls back
 * to the (now identical) master.
 *
 * `force` = the user pressed "ใช้ของฉัน" on a parked conflict: skip the guard and
 * overwrite whatever is there now. Everything else is decided by
 * audioFlushDecision, which is unit-tested in lib/audio-upload-queue.test.ts.
 */
async function applyAudioUploadOp(
  op: AudioUploadOp,
  onLine: boolean,
  force: boolean
): Promise<"applied" | { conflict: string }> {
  const supabase = createClient();
  const { data, error, status } = await supabase
    .from("songs")
    .select("id, audio_path")
    .eq("id", op.id)
    .maybeSingle();
  if (error) {
    if (isQueueableWriteError(error.message, onLine, status)) throw new Error(error.message);
    return { conflict: error.message };
  }
  // An anon read is an empty result too, and "the song is gone" is a terminal
  // verdict — prove the read was ours before believing it (same rule as events).
  if (!data) await requireLiveSession();
  const serverPath = (data?.audio_path as string | null) ?? null;
  const action = force && data ? "upload" : audioFlushDecision(op, { exists: !!data, audioPath: serverPath });

  if (action === "gone") {
    // Nothing to attach the bytes to. Park rather than drop — the file on this
    // device is still the only copy of whatever they picked, and a silent
    // disappearance is exactly what this whole queue exists to prevent.
    return { conflict: "เพลงนี้ถูกลบไปแล้วบนออนไลน์ — อัปไฟล์ขึ้นไม่ได้" };
  }
  if (action === "conflict") return { conflict: audioConflictReason({ audioPath: serverPath }) };

  const local = await getLocalSource(op.id);
  if (action === "upload") {
    if (!local) {
      // The bytes are gone (storage cleared, or the override was replaced by a
      // later deliberate pick). There is nothing left to send.
      return { conflict: "ไม่พบไฟล์เสียงที่รออัปโหลดในเครื่องนี้แล้ว" };
    }
    try {
      // Bounded so the OUTBOX LOCK is always given back. This runs inside
      // withOutboxLock, and the PUT has no timeout of its own — under Electron the
      // bytes go through the main process's net.fetch, which on a black-holed venue
      // AP never settles. An 88 MB master hanging there would hold the lock for the
      // rest of the session: every later offline save silently blocks behind it.
      await Promise.race([
        uploadEventAudio(op.path, local.blob, op.contentType || local.blob.type),
        new Promise<never>((_, reject) =>
          setTimeout(
            // The ASCII "timeout" is not decoration — the classifier below is a
            // regex over the MESSAGE (lib/mgmt-outbox.ts isQueueableWriteError),
            // and it is ASCII-only. A purely Thai message therefore read as a
            // PERMANENT rejection: an 88 MB master that simply needed longer than
            // ten minutes on house wifi got parked as a conflict and dropped from
            // the queue, and that song's audio then never synced again — not at a
            // hotel, not on the next launch. It is the transient failure of all
            // transient failures, so say so in a language the classifier reads.
            () =>
              reject(
                new Error("timeout — หมดเวลาอัปโหลดไฟล์เสียง (เครือข่ายไม่ตอบสนอง)")
              ),
            AUDIO_UPLOAD_TIMEOUT_MS
          )
        ),
      ]);
    } catch (e) {
      // NOT every failure here is a network one: presign answers 403/500/502/503 as
      // a thrown Error too. Rethrowing those broke doFlush's loop, which stops at
      // the first throw — so one permanently-rejected upload wedged the ENTIRE
      // management queue, and every setlist and schedule edit behind it stopped
      // syncing with no error anywhere. Classify like every other write: retry the
      // transient, park the real rejection where a human can see it.
      const msg = e instanceof Error ? e.message : String(e);
      // The status, when the hop had one (lib/audio-remote.ts attaches it): these
      // messages are Thai with a bare number, so the classifier's ASCII word list
      // reads a 503 from presign/R2 as a PERMANENT rejection. This op carries the
      // largest and least recoverable payload in the queue — the only copy of a
      // take the operator picked offline — and parking it means the ชนกัน panel's
      // "ใช้ของออนไลน์" clears the local source and the song falls back to the old
      // master at showtime. Every other write in this file already survives an
      // identical 503 by staying queued.
      const status = (e as { status?: number } | null)?.status;
      if (isQueueableWriteError(msg, onLine, status)) throw e instanceof Error ? e : new Error(msg);
      return { conflict: msg };
    }
    const upd = await supabase
      .from("songs")
      .update({ audio_path: op.path, audio_name: op.fileName, audio_expires_at: null })
      .eq("id", op.id)
      .select("id");
    if (upd.error) {
      if (isQueueableWriteError(upd.error.message, onLine, upd.status))
        throw new Error(upd.error.message);
      return { conflict: upd.error.message };
    }
    if (!upd.data || upd.data.length === 0) {
      // 0 rows and no error: deleted between the guard read and the write — or
      // sent as anon, which looks identical. Re-prove the session before parking.
      await requireLiveSession();
      return { conflict: "เพลงนี้ถูกลบไปแล้วบนออนไลน์ — อัปไฟล์ขึ้นไม่ได้" };
    }
    // Real replace just landed (not the "applied" pass-through below, which means
    // a previous flush already did this) — same trigger the online path fires on.
    broadcastAudioChanged(op.groupId);
  }
  // Landed (or was already landed by a half-finished flush). Best-effort tail —
  // none of it may fail the op, which the server has now accepted.
  if (local) await cacheSongBlob(op.path, local.blob, op.fileName).catch(() => {});
  if (op.basePath && op.basePath !== op.path) removeEventAudio(op.basePath).catch(() => {});
  await clearLocalSource(op.id).catch(() => {});
  return "applied";
}

/**
 * Apply one op online. Returns "applied", or a conflict reason to park it.
 * Throws when the attempt must be RETRIED rather than judged: a NETWORK failure
 * (still offline), or a session we can't prove is live (see hasLiveSession) — the
 * flush loop stops there and leaves the queue untouched.
 */
async function applyOp(op: NewMgmtOp): Promise<"applied" | { conflict: string }> {
  const supabase = createClient();
  const onLine = typeof navigator === "undefined" || navigator.onLine !== false;
  // Never replay as anon (see hasLiveSession): with no token every read below is
  // an empty RLS result and every delete a silent 0-row no-op, so the op would be
  // parked or deleted on a verdict the server never actually gave.
  await requireLiveSession();

  if (isChildListOp(op)) return applyChildListOp(op, onLine, false);
  if (isAudioUploadOp(op)) return applyAudioUploadOp(op, onLine, false);

  if (op.kind === "event.create") {
    // upsert on the client-minted id → idempotent when a half-flushed queue re-runs.
    const { data, error, status } = await supabase
      .from("events")
      .upsert({ ...op.values, id: op.id })
      .select("updated_at");
    if (!error) {
      const ms = Date.parse((data?.[0]?.updated_at as string) ?? "");
      if (!Number.isNaN(ms)) selfWriteMs.set(op.id, ms);
      return "applied";
    }
    if (isQueueableWriteError(error.message, onLine, status)) throw new Error(error.message);
    return { conflict: error.message };
  }

  // Online-wins guard: read the server row before touching it (the whole row —
  // the patch-vs-row idempotence check below needs the columns, not just updated_at).
  const { data, error, status } = await supabase
    .from("events")
    .select("*")
    .eq("id", op.id)
    .maybeSingle();
  if (error) {
    if (isQueueableWriteError(error.message, onLine, status)) throw new Error(error.message);
    return { conflict: error.message };
  }
  if (!data) {
    // Row gone: a delete already holds (idempotent); an edit has nothing to land on.
    // An anon read is empty too, and both verdicts here are terminal (the delete
    // never reaches the server; the edit is parked as "deleted online"), so prove
    // the read was ours before believing the row is really gone.
    await requireLiveSession();
    if (op.kind === "event.delete") return "applied";
    return { conflict: "งานนี้ถูกลบไปแล้วบนออนไลน์" };
  }
  if (
    op.kind === "event.update" &&
    eventPatchApplied(op.patch as Record<string, unknown>, data as Record<string, unknown>)
  ) {
    // Already on the server (crash between apply and delete, or a re-run) —
    // must not park itself as a false conflict.
    return "applied";
  }
  const parsed = Date.parse((data as { updated_at: string }).updated_at);
  const serverMs = Number.isNaN(parsed) ? null : parsed;
  if (!shouldApplyOnFlush(op, serverMs, selfWriteMs.get(op.id) ?? null)) {
    return { conflict: "เวอร์ชันออนไลน์ถูกแก้ไขใหม่กว่าของเครื่องนี้" };
  }

  if (op.kind === "event.update") {
    const res = await supabase
      .from("events")
      .update(op.patch)
      .eq("id", op.id)
      .select("updated_at");
    if (res.error) {
      if (isQueueableWriteError(res.error.message, onLine, res.status))
        throw new Error(res.error.message);
      // 0037: the queued patch tried to set 'approved' without the right — park it
      // in Thai, not with the raw Postgres exception the ชนกัน panel would show.
      if (isApprovalGuardError(res.error.message)) return { conflict: APPROVAL_REASON };
      return { conflict: res.error.message };
    }
    if (!res.data || res.data.length === 0) {
      // Deleted between our guard read and the update (0 rows matched, no error) —
      // but an anon UPDATE matches 0 rows just as quietly, and the session can die
      // between the guard read and this write, so re-prove it before parking.
      await requireLiveSession();
      return { conflict: "งานนี้ถูกลบไปแล้วบนออนไลน์" };
    }
    const ms = Date.parse(res.data[0].updated_at as string);
    if (!Number.isNaN(ms)) selfWriteMs.set(op.id, ms);
    return "applied";
  }
  const res = await supabase.from("events").delete().eq("id", op.id).select("id");
  if (!res.error) {
    if (wroteNothing(res.data)) {
      // 0 rows and no error: the DELETE reached the server and removed nothing.
      // An anon request in the minute after a venue reconnect looks EXACTLY like
      // this, and the old `if (!res.error) return "applied"` recorded it as SYNCED
      // — the queued intent was then deleted, the event stayed alive online, and
      // nothing on any screen said so. Same cure as the update branch above:
      // re-prove the session (a throw leaves the whole queue for the next
      // reconnect), and only judge the write once we know it carried our JWT.
      // With the session proven, 0 rows is a refusal — the guard read a moment ago
      // DID see the row, and the "someone else deleted it first" race that could
      // also land here returns "applied" from that read on the next flush anyway.
      // Parking is the recoverable side of that coin; "ใช้ของออนไลน์" clears it.
      await requireLiveSession();
      return { conflict: DELETE_NO_ROWS_REASON };
    }
    selfWriteMs.delete(op.id);
    return "applied";
  }
  if (isQueueableWriteError(res.error.message, onLine, res.status))
    throw new Error(res.error.message);
  return { conflict: res.error.message };
}

type FlushResult = { flushed: number; parked: number; remaining: number };

let inFlightFlush: Promise<FlushResult> | null = null;

/**
 * Replay the current user's queued ops in seq order. Stops at the first network
 * failure (still offline) and leaves the rest queued; a REJECTED op (RLS, online
 * changed first, row deleted) is parked as a conflict, never dropped.
 * Re-entrant-safe: boot, the 'online' listener, and the chip click can all fire at
 * once — they share ONE run (a second concurrent pass would re-apply the same
 * snapshot and park the user's own just-landed write as a false conflict).
 */
export function flushMgmtOutbox(): Promise<FlushResult> {
  if (inFlightFlush) return inFlightFlush;
  const run = withOutboxLock(doFlush).finally(() => {
    inFlightFlush = null;
  });
  inFlightFlush = run;
  return run;
}

async function doFlush(): Promise<FlushResult> {
  const gen = outboxGeneration;
  let mine: { key: number; rec: OpRec }[];
  try {
    mine = await listMyOps();
  } catch {
    return { flushed: 0, parked: 0, remaining: 0 };
  }
  let flushed = 0;
  let parked = 0;
  for (const { key, rec } of mine) {
    if (gen !== outboxGeneration) break; // signed out mid-replay — the wipe wins
    let outcome: "applied" | { conflict: string };
    try {
      outcome = await applyOp(rec.op);
    } catch {
      break; // network down / session not provably ours — retry on the next reconnect
    }
    if (gen !== outboxGeneration) break; // wiped while this op was in flight
    if (outcome !== "applied") {
      if (!(await parkConflict(rec, outcome.conflict))) {
        // The conflict row did NOT persist (IndexedDB quota — the cached show
        // audio shares this budget — or an aborted tx). Deleting the op now would
        // destroy this venue's offline edit with no error and no conflict panel,
        // so keep it queued instead (the next flush re-derives the same verdict)
        // and say so out loud — it counts as remaining, not parked.
        toast.error(
          "บันทึกรายการที่ชนกันไม่สำเร็จ (พื้นที่เก็บข้อมูลในเครื่องมีปัญหา) — รายการยังอยู่ในคิว ไม่ได้หายไป",
          { id: "mgmt-park-failed" }
        );
        continue;
      }
      parked++;
    } else {
      flushed++;
    }
    await deleteOpIfRevMatches(key, rec.rev ?? 0);
  }
  if (flushed || parked) notify();
  return { flushed, parked, remaining: mine.length - flushed - parked };
}

/** Rewrite a parked conflict's reason in place (e.g. "row gone — can't override"). */
async function setConflictReason(key: number, reason: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(CONFLICTS, "readwrite");
    const store = tx.objectStore(CONFLICTS);
    const get = store.get(key);
    get.onsuccess = () => {
      const rec = get.result as ConflictRec | undefined;
      if (rec) store.put({ ...rec, reason }, key);
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      resolve();
    };
    settleOnAbort(tx);
  });
  notify();
}

/**
 * Resolve a parked conflict. "server" keeps the online version (discard mine);
 * "mine" force-writes the queued value over the server row (the user explicitly
 * chose to override the online-wins default). `ok: false` = the force-write
 * failed and the conflict stays parked; `message` (when set) is the specific
 * Thai reason to surface instead of the generic retry-when-online toast.
 */
export function resolveMgmtConflict(
  key: number,
  choice: "mine" | "server"
): Promise<{ ok: boolean; message?: string }> {
  return withOutboxLock(async () => {
    if (choice === "mine") {
      const all = await listStore<ConflictRec>(CONFLICTS).catch(
        () => [] as { key: number; rec: ConflictRec }[]
      );
      const found = all.find((r) => r.key === key);
      if (found) {
        try {
          const supabase = createClient();
          const op = found.rec.op;
          // "ใช้ของฉัน" only means anything as a REAL write: an anon request (see
          // hasLiveSession) is either refused outright or matches 0 rows in
          // silence, and the 0-row check below would then rewrite this conflict
          // into "กด 'ใช้ของออนไลน์'" — telling the user to throw away work that
          // can still land. Bail out first; the conflict stays parked, unchanged.
          if (!(await hasLiveSession())) return { ok: false, message: NO_SESSION_REASON };
          if (isAudioUploadOp(op)) {
            const onLine = typeof navigator === "undefined" || navigator.onLine !== false;
            // A THROW here is a network failure (applyAudioUploadOp classifies the
            // rest into a conflict reason). Let it reach the outer catch and report
            // the generic "try again when online" — overwriting the parked reason
            // with a raw "Failed to fetch" would permanently replace the real
            // explanation ("someone uploaded over this song") with a transport error.
            const res = await applyAudioUploadOp(op, onLine, true);
            if (res !== "applied") {
              // A deleted song or vanished bytes is not something retrying fixes —
              // keep it parked with THAT reason instead of "try again when online".
              await setConflictReason(key, res.conflict);
              return { ok: false, message: res.conflict };
            }
          } else if (isChildListOp(op)) {
            const onLine = typeof navigator === "undefined" || navigator.onLine !== false;
            const res = await applyChildListOp(op, onLine, true);
            if (res !== "applied") {
              // The force-write hit a real rejection (e.g. a duplicate row the
              // snapshot can't resolve) — keep it parked with THAT reason, so the
              // user isn't told to "try again when online" for something retrying
              // will never fix.
              await setConflictReason(key, res.conflict);
              return { ok: false, message: res.conflict };
            }
          } else if (op.kind === "event.update") {
            let { data, error } = await supabase
              .from("events")
              .update(op.patch)
              .eq("id", op.id)
              .select("id");
            if (error && isApprovalGuardError(error.message) && "status" in op.patch) {
              // 0037: the queued patch is the whole EventForm payload, so it carries
              // the status the row had when the edit was made. If the server has
              // since moved off it, force-writing the patch whole is refused forever
              // — retry without the status so the user's own edits still land.
              const rest = { ...(op.patch as Record<string, unknown>) };
              delete rest.status;
              ({ data, error } = await supabase
                .from("events")
                .update(rest)
                .eq("id", op.id)
                .select("id"));
            }
            if (error) {
              if (isApprovalGuardError(error.message)) {
                await setConflictReason(key, APPROVAL_REASON);
                return { ok: false, message: APPROVAL_REASON };
              }
              return { ok: false };
            }
            if (!data || data.length === 0) {
              // PostgREST reports NO error on a 0-row update — without this check
              // the user's "keep mine" would silently write nothing. The event was
              // deleted online; the patch alone can't recreate it, so keep the
              // conflict parked with an honest reason (ใช้ของออนไลน์ still works).
              // Unless the session died between the check above and this write, in
              // which case 0 rows means "sent as anon", not "deleted online" — say
              // retry, never "discard your work".
              if (!(await hasLiveSession())) return { ok: false, message: NO_SESSION_REASON };
              const reason =
                "งานนี้ถูกลบไปแล้วบนออนไลน์ — เขียนทับไม่ได้ กด 'ใช้ของออนไลน์' เพื่อทิ้งรายการนี้";
              await setConflictReason(key, reason);
              return { ok: false, message: reason };
            }
          } else if (op.kind === "event.create") {
            const { error } = await supabase.from("events").upsert({ ...op.values, id: op.id });
            if (error) return { ok: false };
          } else {
            const { data, error } = await supabase
              .from("events")
              .delete()
              .eq("id", op.id)
              .select("id");
            if (error) return { ok: false };
            if (wroteNothing(data)) {
              // The same 0-row hole the event.update branch above already guards,
              // and the consequence here is the worst one in this function: falling
              // through DELETES the conflict record, so the queued delete is gone
              // for good while the event is still live online. Session first (it can
              // die between the check at the top of this block and this write), then
              // keep the conflict parked with a reason the user can act on.
              if (!(await hasLiveSession())) return { ok: false, message: NO_SESSION_REASON };
              await setConflictReason(key, DELETE_NO_ROWS_REASON);
              return { ok: false, message: DELETE_NO_ROWS_REASON };
            }
          }
        } catch {
          return { ok: false };
        }
      }
    } else {
      // "ใช้ของออนไลน์" on a queued audio upload has to mean it on the SPEAKER too:
      // the file was left as this device's local source so it could be played while
      // offline, and leaving it there would keep this one machine playing the
      // discarded take while every other device has the master. Drop the override.
      const all = await listStore<ConflictRec>(CONFLICTS).catch(
        () => [] as { key: number; rec: ConflictRec }[]
      );
      const op = all.find((r) => r.key === key)?.rec.op;
      if (op && isAudioUploadOp(op)) await clearLocalSource(op.id).catch(() => {});
    }
    await deleteFrom(CONFLICTS, key);
    notify();
    return { ok: true };
  });
}

/** Wipe everything (sign-out on a shared device — ops must not leak across users). */
export async function clearMgmtOutbox(): Promise<void> {
  // Bumped BEFORE taking the lock so a flush already mid-replay sees it and stops:
  // otherwise its remaining ops fail against the revoked session and park fresh
  // conflicts into the store we're about to empty.
  outboxGeneration++;
  await withOutboxLock(async () => {
    try {
      const db = await openDB();
      await new Promise<void>((resolve) => {
        const tx = db.transaction([OPS, CONFLICTS], "readwrite");
        tx.objectStore(OPS).clear();
        tx.objectStore(CONFLICTS).clear();
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          resolve();
        };
        settleOnAbort(tx);
      });
    } catch {
      /* best-effort */
    }
  });
  notify();
}
