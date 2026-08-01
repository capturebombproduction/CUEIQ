// ⭐#1 step 6 (docs/desktop-offline-management.md §6.6) — the OFFLINE AUDIO-UPLOAD
// QUEUE, pure core.
//
// Everything else about a band's work already survives being offline: events,
// setlists, schedules, mics and lineups all queue and sync (steps 2 + 5). The one
// thing that still failed outright was putting a FILE on a song — "อัปโหลดไม่สำเร็จ"
// and the bytes were gone, which at a venue with no usable wifi is the single
// worst moment to lose them.
//
// The trick is that the machinery to hold audio on a device already exists:
// lib/local-source.ts keeps a per-device override blob keyed by songId, and the
// Library's "ดันขึ้นเป็นต้นฉบับ" already knows how to turn one into the online
// master. So a failed offline upload is not a new kind of thing — it is a local
// source plus a REMEMBERED INTENT to push it. The intent rides the existing
// management outbox as an `audio.upload` op (same queue, same chips, same
// conflict panel, same session gating); only the BYTES live elsewhere, because a
// queue that loads every 88 MB master into memory just to count itself is not a
// queue anyone wants on a show machine.
//
// Pure and side-effect free. The IndexedDB work and the flusher live in
// desktop/src/data/mgmt-outbox.ts; the web registers no sink, so an upload
// failure there surfaces exactly as it always did.

/**
 * A remembered "push these bytes to this song when the network is back". The
 * bytes themselves are the song's local source (lib/local-source.ts, keyed by the
 * same songId), which is also what this device plays in the meantime.
 */
export interface AudioUploadOp {
  kind: "audio.upload";
  /** The library songId. Doubles as the queue key — one pending upload per song. */
  id: string;
  tenantId: string;
  groupId: string;
  /**
   * The R2 object key, minted at QUEUE time rather than at flush time. That is
   * what makes a half-finished flush safe to re-run: if we PUT the bytes and
   * committed the row but died before dequeuing, the song's audio_path already
   * equals this key and the next flush recognises its own work instead of
   * uploading a second copy under a fresh random name.
   */
  path: string;
  fileName: string;
  contentType: string;
  /**
   * The song's audio_path at the moment we queued — "the master I was replacing".
   * The flush guard compares the server against it to tell a clean replace from
   * someone else having uploaded meanwhile.
   */
  basePath: string | null;
  /** Display only, so the pending/conflict chips can name the song. */
  songTitle: string | null;
}

/**
 * What to do with a pending upload now that we're back online, given the song row
 * as the server currently has it.
 *
 * - `gone`     — the song was deleted (or is no longer visible to us) while we
 *                were offline. There is nothing to attach the bytes to; drop the
 *                op rather than resurrect a row the band removed.
 * - `applied`  — the server already points at OUR key. A previous flush got
 *                further than it managed to record. Finish quietly: no second
 *                upload, no conflict.
 * - `upload`   — the master is still the one we were replacing (or there was
 *                none). Push the bytes and commit the row.
 * - `conflict` — someone else changed this song's audio while we were offline.
 *                Overwriting would silently destroy their master, so park it and
 *                let a human choose. The bytes stay on the device either way.
 */
export type AudioFlushAction = "gone" | "applied" | "upload" | "conflict";

export function audioFlushDecision(
  op: Pick<AudioUploadOp, "path" | "basePath">,
  server: { exists: boolean; audioPath: string | null }
): AudioFlushAction {
  if (!server.exists) return "gone";
  if (server.audioPath === op.path) return "applied";
  // Both null (the song had no audio and still has none) also lands here — a first
  // upload onto a fresh song is the cleanest case there is.
  if (server.audioPath === op.basePath) return "upload";
  return "conflict";
}

/** Why a parked audio upload is parked, in the words the panel shows. */
export function audioConflictReason(server: { audioPath: string | null }): string {
  return server.audioPath === null
    ? "มีคนลบไฟล์เสียงของเพลงนี้ตอนที่เครื่องนี้ออฟไลน์"
    : "มีคนอัปไฟล์เสียงของเพลงนี้ทับตอนที่เครื่องนี้ออฟไลน์";
}

/**
 * Toast copy for an upload that got queued instead of failing. Deliberately
 * concrete about the two things the person standing at the venue needs to know:
 * the file is not lost, and it already plays HERE.
 */
export const AUDIO_QUEUED_MESSAGE =
  "ออฟไลน์อยู่ — เก็บไฟล์ไว้ในเครื่องแล้ว เล่นได้เลยบนเครื่องนี้ และจะอัปขึ้นคลังให้เมื่อเน็ตกลับ";

/**
 * A blob big enough that queueing it is likely to blow the origin's storage quota
 * and take the rest of the offline data down with it. The real masters are 27–88
 * MB WAVs, so this is not a small ceiling — it exists so that queueing one absurd
 * file at a venue can't cost someone their setlist edits.
 */
export const MAX_QUEUED_AUDIO_BYTES = 300 * 1024 * 1024;
