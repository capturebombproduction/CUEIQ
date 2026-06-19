// ---------------------------------------------------------------------------
// Online audio files — Supabase Storage (private bucket "event-audio").
//
// Live Mode used to keep audio only on the device that picked the file
// (IndexedDB). These helpers move the bytes into a PRIVATE bucket so a file
// uploaded on one device plays on every logged-in device of the same tenant.
// Access is gated by Storage RLS keyed off the first path segment (tenant id) —
// see supabase/migrations/0004_audio_storage.sql. IndexedDB stays as a cache.
//
// We download to a Blob (not a streaming signed URL) so playback survives a
// flaky venue network and a long show with no URL expiry.
// ---------------------------------------------------------------------------

import { createClient } from "@/lib/supabase/client";

const BUCKET = "event-audio";

function extOf(fileName: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(fileName);
  return m ? m[1].toLowerCase() : "audio";
}

function token(): string {
  const r =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Math.random()).slice(2);
  return r.replace(/-/g, "").slice(0, 8);
}

/**
 * Build the object key: <tenant>/<event>/<item>-<rand>.<ext>.
 * The FIRST segment is the tenant id so Storage RLS can key off it, and the
 * random suffix means a replaced file gets a NEW path → caches invalidate and
 * no CDN/object staleness.
 */
export function buildAudioPath(
  tenantId: string,
  eventId: string,
  itemId: string,
  fileName: string
): string {
  return `${tenantId}/${eventId}/${itemId}-${token()}.${extOf(fileName)}`;
}

export async function uploadEventAudio(
  path: string,
  file: File | Blob,
  contentType?: string
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    upsert: true,
    cacheControl: "3600",
    contentType: contentType || (file as File).type || undefined,
  });
  if (error) throw error;
}

export async function downloadEventAudio(path: string): Promise<Blob> {
  const supabase = createClient();
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) throw error ?? new Error("ดาวน์โหลดไฟล์เสียงไม่สำเร็จ");
  return data;
}

export async function removeEventAudio(path: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) throw error;
}
