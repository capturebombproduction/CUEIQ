// The write seam for management data (⭐#1 step 2, docs/desktop-offline-management.md
// §3c/§5). EventForm routes its create/update through saveEventWrite instead of
// calling Supabase inline, giving the desktop ONE place to catch a network failure
// and queue the write for later sync.
//
// On the WEB nothing registers a queue sink, so behavior is byte-identical to the
// old inline calls: try online, surface the error. Only the desktop boot
// (desktop/src/main.tsx) registers a sink pointing at its IndexedDB outbox — then a
// network failure (and only a network failure — RLS/validation errors still surface)
// becomes a queued op + an immediate optimistic result.
import { createClient } from "@/lib/supabase/client";
import { MAX_QUEUED_AUDIO_BYTES } from "@/lib/audio-upload-queue";
import { clearLocalSource, setLocalSource } from "@/lib/local-source";
import {
  fingerprintChildRows,
  isQueueableWriteError,
  newEventId,
  sanitizeChildRows,
  type ChildListKind,
  type NewMgmtOp,
} from "@/lib/mgmt-outbox";
import type { EventRow } from "@/lib/types";
import { noRowsMessage, wroteNothing } from "@/lib/write-guard";

/** Shared toast copy for any management write that got queued for later sync. */
export const OFFLINE_QUEUED_MESSAGE =
  "ออฟไลน์อยู่ — บันทึกไว้ในเครื่องแล้ว จะซิงค์ให้เมื่อเน็ตกลับ";

type MgmtQueueSink = (op: NewMgmtOp) => Promise<void>;

let queueSink: MgmtQueueSink | null = null;

/** Desktop-only: point failed writes at the offline outbox. Web never calls this. */
export function registerMgmtQueueSink(sink: MgmtQueueSink | null): void {
  queueSink = sink;
}

/** songIds with an audio upload still waiting to be pushed (⭐#1 step 6). */
type PendingAudioReader = () => Promise<Set<string>>;

let pendingAudioReader: PendingAudioReader | null = null;

/** Desktop-only: let shared UI ask the outbox which songs are still waiting. */
export function registerPendingAudioReader(reader: PendingAudioReader | null): void {
  pendingAudioReader = reader;
}

type PendingAudioDropper = (songId: string) => Promise<void>;

let pendingAudioDropper: PendingAudioDropper | null = null;

/** Desktop-only: let shared UI cancel a queued upload that has been superseded. */
export function registerPendingAudioDropper(dropper: PendingAudioDropper | null): void {
  pendingAudioDropper = dropper;
}

/**
 * Forget a queued upload for this song, bytes and all. Called when something makes
 * it obsolete — most importantly a LATER successful upload: without this the device
 * keeps a local-source override of the old take, and lib/local-source is the FIRST
 * thing Live Mode consults, so the machine wired to the PA would play a take
 * nobody else has.
 */
export async function dropPendingAudioUpload(songId: string): Promise<void> {
  if (!pendingAudioDropper) return;
  try {
    await pendingAudioDropper(songId);
  } catch {
    /* best effort — never fail a successful upload over its own bookkeeping */
  }
}

/**
 * Which songs have bytes sitting on this device waiting to become the master.
 * Always resolves — the web (and any failure) reports none, so the Library simply
 * renders no "รออัปโหลด" badges rather than breaking.
 */
export async function listPendingAudioUploads(): Promise<Set<string>> {
  if (!pendingAudioReader) return new Set();
  try {
    return await pendingAudioReader();
  } catch {
    return new Set();
  }
}

export type SaveEventResult =
  | { ok: true; id: string; queued: boolean }
  | { ok: false; message?: string };

export async function saveEventWrite(args: {
  mode: "create" | "edit";
  payload: Partial<EventRow>;
  /** edit: the row being edited */
  eventId?: string;
  /** create: stamped as created_by */
  createdBy?: string;
  /** edit: event.updated_at we loaded — the online-wins guard's reference point */
  baseUpdatedAt?: string | null;
}): Promise<SaveEventResult> {
  const onLine = typeof navigator === "undefined" || navigator.onLine !== false;
  // Known-offline with a queue available: skip the doomed network attempt.
  if (queueSink && !onLine) return queueWrite(args);

  try {
    const supabase = createClient();
    if (args.mode === "create") {
      const { data, error } = await supabase
        .from("events")
        .insert({ ...args.payload, created_by: args.createdBy })
        .select("id")
        .single();
      if (!error && data) return { ok: true, id: data.id as string, queued: false };
      if (queueSink && isQueueableWriteError(error?.message, onLine)) return queueWrite(args);
      return { ok: false, message: error?.message };
    }
    const { data, error } = await supabase
      .from("events")
      .update(args.payload)
      .eq("id", args.eventId!)
      .select("id");
    // A write that reported no error but touched NO ROW did not happen — the
    // request went out as anon (expired token, failed refresh) and RLS filtered it
    // to nothing, or the event is gone. Reporting ok here is how an edit gets a
    // green "บันทึกแล้ว" and lands nowhere. See lib/write-guard.ts.
    if (!error && wroteNothing(data)) {
      return { ok: false, message: await noRowsMessage() };
    }
    if (!error) return { ok: true, id: args.eventId!, queued: false };
    if (queueSink && isQueueableWriteError(error.message, onLine)) return queueWrite(args);
    return { ok: false, message: error.message };
  } catch (e) {
    // supabase-js normally returns errors; an actual throw here is a transport
    // failure — queueable when the desktop sink exists.
    if (queueSink) return queueWrite(args);
    return { ok: false, message: e instanceof Error ? e.message : undefined };
  }
}

/**
 * ⭐#1 step 5 — the child-list fallback the 4 editors (setlist/schedule/mic/lineup)
 * call AFTER their normal online write failed. When a queue sink exists (desktop)
 * and the failure was a network failure (or we're plainly offline), the editor's
 * whole post-edit list is queued as ONE snapshot op and `true` comes back — the
 * caller keeps its optimistic state instead of rolling back. On the web (no sink)
 * or for a real rejection (RLS/validation/constraint) this returns `false` and the
 * editor's original error handling runs unchanged.
 *
 * `rows` = the post-edit full list; `baseRows` = the PRE-edit list (the last-known
 * server state — the online-wins guard's reference). For lineup both are
 * member_id arrays. When a snapshot is already queued for this (event × table),
 * the planner keeps the original base, so passing locally-advanced baseRows on
 * later edits is correct.
 */
export async function tryQueueChildList(args: {
  kind: ChildListKind;
  eventId: string;
  tenantId: string;
  /** Display only — makes the "ชนกัน" panel readable. */
  eventName?: string | null;
  rows: unknown[];
  baseRows: unknown[];
  errorMessage?: string | null;
}): Promise<boolean> {
  if (!queueSink) return false;
  const onLine = typeof navigator === "undefined" || navigator.onLine !== false;
  if (!isQueueableWriteError(args.errorMessage ?? null, onLine)) return false;
  try {
    await queueSink({
      kind: args.kind,
      id: args.eventId,
      tenantId: args.tenantId,
      eventName: args.eventName ?? null,
      rows: sanitizeChildRows(args.kind, args.rows),
      base: fingerprintChildRows(args.kind, args.baseRows),
    });
    return true;
  } catch {
    // IndexedDB unavailable/full — genuinely can't queue; let the caller surface
    // its normal error (the write is lost either way, but never silently).
    return false;
  }
}

/**
 * ⭐#1 step 6 — the audio-upload fallback the Library calls after an R2 upload
 * failed. When a queue sink exists (desktop) and the failure was a network one,
 * the bytes are kept as this song's LOCAL SOURCE — so this device plays them
 * immediately, exactly as if the user had pressed "ใช้ไฟล์ในเครื่องนี้" — and an
 * `audio.upload` op remembers to push them as the master when the network is back.
 * Returns true when that happened; false leaves the caller's own error handling
 * untouched (the web always takes that path, as do real rejections).
 *
 * Bytes first, intent second, and the bytes are rolled back if the intent won't
 * store: a local override with nothing queued behind it would quietly make one
 * machine play a file no one else can hear, with nothing on screen saying so.
 */
export async function tryQueueAudioUpload(args: {
  songId: string;
  tenantId: string;
  groupId: string;
  /** The R2 key the failed upload was aiming at — reused verbatim on flush. */
  path: string;
  file: Blob;
  fileName: string;
  contentType: string;
  /** The song's audio_path before this upload — the flush guard's reference. */
  basePath: string | null;
  songTitle: string | null;
  errorMessage?: string | null;
}): Promise<boolean> {
  if (!queueSink) return false;
  const onLine = typeof navigator === "undefined" || navigator.onLine !== false;
  if (!isQueueableWriteError(args.errorMessage ?? null, onLine)) return false;
  // Refuse absurd files rather than take the whole origin's storage down with
  // them — the queued setlist edits sitting in the same budget are not worth a
  // gigabyte of stems.
  if (args.file.size > MAX_QUEUED_AUDIO_BYTES) return false;
  try {
    await setLocalSource(args.songId, args.file, args.fileName);
  } catch {
    return false; // no room / IndexedDB unavailable — nothing to promise
  }
  try {
    await queueSink({
      kind: "audio.upload",
      id: args.songId,
      tenantId: args.tenantId,
      groupId: args.groupId,
      path: args.path,
      fileName: args.fileName,
      contentType: args.contentType,
      basePath: args.basePath,
      songTitle: args.songTitle,
    });
    return true;
  } catch {
    await clearLocalSource(args.songId).catch(() => {});
    return false;
  }
}

async function queueWrite(
  args: Parameters<typeof saveEventWrite>[0]
): Promise<SaveEventResult> {
  const sink = queueSink!;
  try {
    if (args.mode === "create") {
      const id = newEventId();
      await sink({
        kind: "event.create",
        id,
        values: { ...args.payload, created_by: args.createdBy ?? null },
      });
      return { ok: true, id, queued: true };
    }
    await sink({
      kind: "event.update",
      id: args.eventId!,
      patch: args.payload,
      base: args.baseUpdatedAt ? Date.parse(args.baseUpdatedAt) || null : null,
    });
    return { ok: true, id: args.eventId!, queued: true };
  } catch {
    // IndexedDB unavailable/full — the write is genuinely lost; tell the user.
    return { ok: false, message: "บันทึกออฟไลน์ไม่สำเร็จ (พื้นที่เก็บข้อมูลในเครื่องมีปัญหา)" };
  }
}
