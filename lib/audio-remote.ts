// ---------------------------------------------------------------------------
// Online audio files — Cloudflare R2 (private bucket, via presigned URLs).
//
// Live Mode used to keep audio only on the device that picked the file
// (IndexedDB). These helpers move the bytes into PRIVATE R2 object storage so a
// file uploaded on one device plays on every logged-in device of the same
// tenant. The real WAV masters are 27–88 MB, so the bytes travel browser ↔ R2
// directly through short-lived presigned URLs — they never pass through our
// serverless function, and R2 charges zero egress.
//
// Access is gated by /api/audio/presign, which checks the Supabase session and
// the tenant (first path segment) with the same is_tenant_member /
// can_edit_tenant predicates the old Storage RLS used. IndexedDB stays a cache.
//
// This is the single transport seam: live-mode.tsx and setlist-builder.tsx call
// the four functions below and don't care whether the backend is R2 or Storage.
// ---------------------------------------------------------------------------

const PRESIGN_ENDPOINT = "/api/audio/presign";

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
 * Build the object key: <tenant>/<group>/<event>/<item>-<rand>.<ext>.
 * The FIRST segment is the tenant id so the presign route can authorize off it
 * (the group/event/item segments are just organisation — auth never depends on
 * them). The group segment keeps each band's audio under its own prefix so files
 * can be listed/measured/cleared per band as the label grows. The random suffix
 * means a replaced file gets a NEW key → caches invalidate, no object staleness.
 *
 * Older keys are 3-segment (<tenant>/<event>/<item>); both still authorize fine
 * since tenant is always segment 0, and stored audio_path values are used as-is.
 */
export function buildAudioPath(
  tenantId: string,
  groupId: string,
  eventId: string,
  itemId: string,
  fileName: string
): string {
  return `${tenantId}/${groupId}/${eventId}/${itemId}-${token()}.${extOf(fileName)}`;
}

/**
 * Object key for a LIBRARY song's audio: <tenant>/<group>/songs/<song>-<rand>.<ext>.
 * Same tenant-first convention so the presign route authorizes identically; the
 * "songs" segment groups all library audio under one prefix per band.
 */
export function buildSongAudioPath(
  tenantId: string,
  groupId: string,
  songId: string,
  fileName: string
): string {
  return `${tenantId}/${groupId}/songs/${songId}-${token()}.${extOf(fileName)}`;
}

async function presign(key: string, op: "get" | "put"): Promise<string> {
  const res = await fetch(PRESIGN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, op }),
  });
  if (!res.ok) {
    throw new Error(`ขอลิงก์ ${op} ไม่สำเร็จ (${res.status})`);
  }
  const data = (await res.json()) as { url?: string };
  if (!data.url) throw new Error("presign: missing url");
  return data.url;
}

/**
 * Retry a transfer a few times with linear backoff. Venue Wi-Fi drops packets,
 * and the WAVs are big, so a single transient failure shouldn't doom a file.
 * Each attempt re-presigns (a fresh 15-min URL) so an expired/edge-cached URL
 * isn't reused. On persistent failure it throws the last error, same as before.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 700
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

export async function uploadEventAudio(
  path: string,
  file: File | Blob,
  contentType?: string
): Promise<void> {
  await withRetry(async () => {
    const url = await presign(path, "put");
    const type = contentType || (file as File).type || "";
    const res = await fetch(url, {
      method: "PUT",
      body: file,
      // Content-Type is NOT part of the presigned signature (we sign only host), so
      // sending it is safe and lets R2 store a sensible type for playback.
      headers: type ? { "Content-Type": type } : undefined,
    });
    if (!res.ok) throw new Error(`อัปโหลดไฟล์เสียงไม่สำเร็จ (${res.status})`);
  });
}

export async function downloadEventAudio(path: string): Promise<Blob> {
  return withRetry(async () => {
    const url = await presign(path, "get");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ดาวน์โหลดไฟล์เสียงไม่สำเร็จ (${res.status})`);
    return res.blob();
  });
}

export async function removeEventAudio(path: string): Promise<void> {
  // DELETE runs server-side (no presigned URL) so the browser needs no R2 CORS
  // entry for it and the key is re-validated against the session.
  const res = await fetch(PRESIGN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: path, op: "delete" }),
  });
  if (!res.ok) throw new Error(`ลบไฟล์เสียงไม่สำเร็จ (${res.status})`);
}
