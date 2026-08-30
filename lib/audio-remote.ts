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

// ---------------------------------------------------------------------------
// Transport config — the one seam that lets the desktop app reuse this file.
// The WEB app leaves these at their defaults: a same-origin relative endpoint
// authorized by the cookie session. The DESKTOP app (no API routes of its own)
// points `endpointBase` at the web origin and supplies a Bearer token via
// `getAuthHeaders`, since cross-origin requests don't carry the web's cookies.
// Both paths hit the SAME /api/audio/presign route (it accepts either). See
// desktop/src/main.tsx (configureAudioTransport) and the route's Bearer/CORS.
// ---------------------------------------------------------------------------
type AuthHeaderProvider = () => Promise<Record<string, string>>;
type BlobFetcher = (url: string) => Promise<Blob>;
type BlobPutter = (url: string, body: Blob, contentType?: string) => Promise<void>;
let endpointBase = "";
let getAuthHeaders: AuthHeaderProvider | null = null;
// Byte-transfer overrides. The web leaves these null → the browser fetches the
// presigned R2 URL directly. The desktop app (Electron) routes the actual GET/PUT
// of bytes through the main process (Node net.fetch — no browser CORS, so the R2
// bucket never needs the desktop origin whitelisted). The presign call itself
// still happens here in the renderer (it needs the user's session token).
let fetchBlobImpl: BlobFetcher | null = null;
let putBlobImpl: BlobPutter | null = null;

export function configureAudioTransport(opts: {
  endpointBase?: string;
  getAuthHeaders?: AuthHeaderProvider;
  fetchBlob?: BlobFetcher;
  putBlob?: BlobPutter;
}): void {
  if (opts.endpointBase != null) endpointBase = opts.endpointBase.replace(/\/$/, "");
  if (opts.getAuthHeaders) getAuthHeaders = opts.getAuthHeaders;
  if (opts.fetchBlob) fetchBlobImpl = opts.fetchBlob;
  if (opts.putBlob) putBlobImpl = opts.putBlob;
}

async function endpointHeaders(): Promise<Record<string, string>> {
  const base: Record<string, string> = { "Content-Type": "application/json" };
  if (!getAuthHeaders) return base;
  return { ...base, ...(await getAuthHeaders()) };
}

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

/** Image types a feedback screenshot may be. Must stay in step with
 *  FEEDBACK_IMAGE_FILE in lib/presign-authz.ts — a type this list allows but that
 *  pattern does not is a 400 the user reads as "แนบรูปไม่ได้". A test pins them
 *  together (lib/presign-authz.test.ts). */
export const FEEDBACK_IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "heic"] as const;

/**
 * Object key for a screenshot attached to a feedback report:
 *   <tenant>/feedback/<authorUserId>/<rand>.<ext>
 *
 * The AUTHOR'S id is a segment on purpose. `public.feedback` has no group_id, so
 * there is no band to scope these to, and the tenant-level fallback the presign
 * route used before 0043 was wrong in both directions (writes were admin-only, and
 * reads were open to the whole label). With the author in the key, the route can
 * answer "the author, or an admin" — exactly what feedback_select says about the
 * row these bytes belong to — without reading anything.
 *
 * The random token is 16 chars rather than the audio builders' 8: these keys are
 * guessable in shape and, unlike a song, the object is only ever fetched through a
 * presigned URL an authorized caller minted, so the token is defence in depth, not
 * the lock.
 */
export function buildFeedbackImagePath(
  tenantId: string,
  authorUserId: string,
  fileName: string
): string {
  const ext = extOf(fileName);
  const safe = (FEEDBACK_IMAGE_EXTS as readonly string[]).includes(ext) ? ext : "png";
  return `${tenantId}/feedback/${authorUserId}/${token()}${token()}.${safe}`;
}

// ---------------------------------------------------------------------------
// Timeouts + cancellation. Venue Wi-Fi doesn't only drop packets, it BLACK-HOLES
// connections: a fetch with no signal then hangs forever, and withRetry used to
// happily sleep and restart a whole 88 MB download even after the operator had
// pressed "หยุด". That froze "เตรียมเพลง" at 0/N with a dead stop button — on the
// very flow whose job is to guarantee the show can run offline. Every hop below
// is now bounded, and a caller's cancel signal aborts the transfer IN FLIGHT
// instead of only being noticed between files.
// ---------------------------------------------------------------------------

/** A presign POST is a few hundred bytes — past this the network is black-holed. */
const PRESIGN_TIMEOUT_MS = 20_000;
/** A feedback screenshot is a few hundred KB, not an 88 MB master: one flat cap. */
const IMAGE_TIMEOUT_MS = 30_000;
/**
 * Byte transfers are bounded on NO PROGRESS, not on a flat deadline: a 27–88 MB
 * master over venue Wi-Fi may legitimately take many minutes, but it should never
 * go this long without a single chunk arriving.
 */
const STALL_TIMEOUT_MS = 45_000;
/**
 * Absolute cap for the one hop whose progress we can't watch: under Electron the
 * bytes come back from the main process as ONE Blob over IPC (no stream, and
 * window.cueiqNative.fetchAudio takes no AbortSignal). Deliberately generous — it
 * exists to break a hang, not to police a slow link. That transfer may still run
 * to completion in the main process afterwards; we just stop blocking on it.
 *
 * A flat cap is the least-bad shape here (the browser path gets a no-progress rule
 * for free from its chunk tap; this one has no progress signal at all), and it is
 * exactly WHY hitting it is terminal — never retried. The main process keeps
 * pulling the bytes after we stop waiting, so a retry would put a SECOND full copy
 * of the same 27–88 MB master on the same link: the two halve each other's
 * bandwidth, both blow the cap, and a file that would have finished ends up
 * failing. One slow file now fails ONCE instead of stacking copies of itself.
 * The price: a link slower than roughly 100 kB/s loses that file instead of
 * eventually finishing it — the operator still has the on-device cache,
 * "ใช้ไฟล์ในเครื่องนี้", and pressing "เตรียมเพลง" again. Doing better needs a
 * progress + cancel channel on the IPC itself (desktop/electron/main.cjs).
 */
const NATIVE_TRANSFER_TIMEOUT_MS = 15 * 60_000;

/**
 * A failure that must NOT be retried, tagged so withRetry can tell it apart from
 * an ordinary transient one. Two things raise it: the operator's "หยุด", and a hop
 * we ABANDONED on its deadline while it keeps running underneath us (see
 * NATIVE_TRANSFER_TIMEOUT_MS) — napping 700 ms and starting that one over is what
 * turns one slow file into three concurrent copies of itself.
 */
type TerminalError = Error & { cueiqTerminal: true };
function terminalError(message: string): TerminalError {
  return Object.assign(new Error(message), { cueiqTerminal: true as const });
}
function isTerminalError(e: unknown): boolean {
  return e instanceof Error && (e as Partial<TerminalError>).cueiqTerminal === true;
}

/**
 * A failed HTTP hop, carrying the code the server actually answered with.
 *
 * The message is Thai (it is shown to the operator), and a Thai message tells a
 * classifier nothing: desktop/src/data/mgmt-outbox.ts decides whether a failed
 * offline audio flush is RETRIED or parked forever, and that decision is
 * isQueueableWriteError — which reads an HTTP status, falling back to an
 * ASCII-only word list. Without the status a 503 from presign or R2 looked exactly
 * like a permanent rejection, so a queued master was parked and dropped from the
 * queue; "ใช้ของออนไลน์" on that conflict then clears the local source, i.e. the
 * only copy of that take. Attach the number so a sick server stays retryable.
 */
function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * An AbortSignal bounded by a timer AND by the caller's own signal, plus the
 * cleanup that must run in a `finally` (a live timer/listener keeps the whole
 * transfer's closure alive). `ping()` restarts the countdown — that is what turns
 * the flat timeout into a no-progress one. Hand-wired because AbortSignal.any /
 * AbortSignal.timeout aren't safe to assume across every browser + Electron
 * Chromium this ships to.
 */
function boundedSignal(ms: number, outer?: AbortSignal) {
  const ac = new AbortController();
  const abort = () => ac.abort();
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(abort, ms);
  outer?.addEventListener("abort", abort);
  if (outer?.aborted) abort();
  return {
    signal: ac.signal,
    ping() {
      if (!timer) return;
      clearTimeout(timer);
      timer = setTimeout(abort, ms);
    },
    done() {
      if (timer) clearTimeout(timer);
      timer = null;
      outer?.removeEventListener("abort", abort);
    },
  };
}

/**
 * Stop WAITING on a promise we can't actually cancel — the Electron main-process
 * byte transfer, or the token refresh hiding inside endpointHeaders() — once the
 * caller aborts or the cap elapses. The work may still finish out of band; the
 * point is only that the UI is never held hostage by it.
 *
 * Giving up on the deadline is TERMINAL by default, because the abandoned hop is
 * normally still running and a retry would race a second copy of it. Pass
 * `retryableTimeout` for a hop where that isn't true and another attempt can
 * genuinely succeed.
 */
function raceAbort<T>(
  p: Promise<T>,
  ms: number,
  outer?: AbortSignal,
  opts: { timeoutMessage?: string; retryableTimeout?: boolean } = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      finish();
      // "หยุด" is final by definition — never nap and start the master over.
      reject(terminalError("ยกเลิกการโหลดไฟล์เสียง"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      finish();
      const msg = opts.timeoutMessage ?? "หมดเวลาโหลดไฟล์เสียง";
      reject(opts.retryableTimeout ? new Error(msg) : terminalError(msg));
    }, ms);
    // attached even after we've given up, so a late rejection is never "unhandled"
    p.then(
      (v) => {
        if (settled) return;
        finish();
        resolve(v);
      },
      (e) => {
        if (settled) return;
        finish();
        reject(e);
      }
    );
    if (outer?.aborted) onAbort();
    else outer?.addEventListener("abort", onAbort);
  });
}

/** Backoff nap that wakes early (and lets the retry loop bail) when cancelled. */
function nap(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    if (signal?.aborted) wake();
    else signal?.addEventListener("abort", wake);
  });
}

async function presign(
  key: string,
  op: "get" | "put",
  signal?: AbortSignal
): Promise<string> {
  // The AUTH hop is bounded too — it is a NETWORK hop, not local work. Reading the
  // token only stays local while it is still valid: on desktop endpointHeaders()
  // goes through Supabase getSession(), and an expired token makes that fire a
  // refresh POST with no timeout of its own, which on a black-holed venue AP never
  // settles. Awaiting it unbounded hung the whole presign before any signal had a
  // listener — dead "หยุด", เตรียมเพลง stuck at 0/N, every later row silent at
  // showtime. Timing out here stays RETRYABLE (unlike the byte transfer): a refresh
  // that is merely slow usually lands during the backoff, and the next attempt then
  // reads the fresh token straight out of the session store.
  const headers = await raceAbort(endpointHeaders(), PRESIGN_TIMEOUT_MS, signal, {
    timeoutMessage: "หมดเวลายืนยันสิทธิ์ (เครือข่ายไม่ตอบสนอง)",
    retryableTimeout: true,
  });
  // Cancelled while the token was resolving (headers won that race by a hair) →
  // don't fire a POST nobody is waiting for.
  if (signal?.aborted) throw terminalError("ยกเลิกการโหลดไฟล์เสียง");
  // Only NOW start the request's own countdown, so auth time isn't charged to it.
  const t = boundedSignal(PRESIGN_TIMEOUT_MS, signal);
  try {
    const res = await fetch(`${endpointBase}${PRESIGN_ENDPOINT}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ key, op }),
      signal: t.signal,
    });
    if (!res.ok) {
      throw httpError(`ขอลิงก์ ${op} ไม่สำเร็จ (${res.status})`, res.status);
    }
    const data = (await res.json()) as { url?: string };
    if (!data.url) throw new Error("presign: missing url");
    return data.url;
  } finally {
    t.done();
  }
}

/**
 * Retry a transfer a few times with linear backoff. Venue Wi-Fi drops packets,
 * and the WAVs are big, so a single transient failure shouldn't doom a file.
 * Each attempt re-presigns (a fresh 15-min URL) so an expired/edge-cached URL
 * isn't reused. On persistent failure it throws the last error, same as before.
 * A CANCELLED transfer is never retried: "หยุด" has to actually stop the bytes,
 * not nap 700 ms and start the whole master over. Same for any other terminal
 * failure (a hop we abandoned on its deadline but that is still running) — see
 * terminalError.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 700,
  signal?: AbortSignal
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (signal?.aborted || isTerminalError(e)) throw e;
      if (i < attempts - 1) {
        await nap(delayMs * (i + 1), signal);
        if (signal?.aborted) throw e;
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
    if (putBlobImpl) {
      // Electron: PUT the bytes via the main process (no browser CORS).
      await putBlobImpl(url, file instanceof Blob ? file : new Blob([file]), type || undefined);
      return;
    }
    const res = await fetch(url, {
      method: "PUT",
      body: file,
      // Content-Type is NOT part of the presigned signature (we sign only host), so
      // sending it is safe and lets R2 store a sensible type for playback.
      headers: type ? { "Content-Type": type } : undefined,
    });
    if (!res.ok) throw httpError(`อัปโหลดไฟล์เสียงไม่สำเร็จ (${res.status})`, res.status);
  });
}

/**
 * Fetch a small image object (a feedback screenshot) as a Blob.
 *
 * Deliberately NOT downloadEventAudio: that one is built for 27–88 MB masters and
 * drags three retries, a 45 s no-progress stall clock, a visibilitychange ping and
 * a byte-counting TransformStream along with it. A screenshot is one round trip.
 *
 * It does keep the one thing that matters on the desktop: under Electron the bytes
 * come back through the main process (fetchBlobImpl), because the renderer's origin
 * is file:// and a direct fetch of an R2 URL is CORS-blocked there. An <img src>
 * would load — img tags are not subject to CORS — but the presigned URL dies after
 * 15 minutes, and a Dev Inbox left open all afternoon would then show broken boxes.
 */
export async function fetchImageBlob(path: string): Promise<Blob> {
  const url = await presign(path, "get");
  // BOUNDED ON BOTH BRANCHES. A screenshot is one small round trip, so a flat
  // deadline is right — and both hops are otherwise unbounded: a bare fetch hangs
  // for ever on a black-holed venue AP, and the Electron bridge takes no
  // AbortSignal at all (its main-process net.fetch has no timeout either). Left
  // open, the Dev Inbox and ที่ส่งไปแล้ว spin for ever instead of reaching the
  // "โหลดรูปไม่ได้" placeholder that already exists for a rejected fetch.
  if (fetchBlobImpl) {
    return raceAbort(fetchBlobImpl(url), IMAGE_TIMEOUT_MS, undefined, {
      timeoutMessage: "โหลดรูปไม่สำเร็จ (หมดเวลา)",
    });
  }
  const t = boundedSignal(IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: t.signal });
    if (!res.ok) throw httpError(`โหลดรูปไม่สำเร็จ (${res.status})`, res.status);
    return await res.blob();
  } finally {
    t.done();
  }
}

export async function downloadEventAudio(
  path: string,
  opts: { signal?: AbortSignal } = {}
): Promise<Blob> {
  const { signal } = opts;
  return withRetry(
    async () => {
      const url = await presign(path, "get", signal);
      // Electron: GET the bytes via the main process (no browser CORS). That hop
      // takes no AbortSignal, so it's raced rather than aborted — and because it
      // keeps running after we give up, hitting the cap is terminal (no retry, or
      // we'd stack a second copy of the same master on the same link). See the cap.
      if (fetchBlobImpl) {
        return raceAbort(fetchBlobImpl(url), NATIVE_TRANSFER_TIMEOUT_MS, signal);
      }
      const t = boundedSignal(STALL_TIMEOUT_MS, signal);
      // A FROZEN page runs no JS, so the chunk tap below can't ping while the
      // operator is off in another app (backgrounded phone tab, laptop asleep).
      // The stall clock would bank that whole pause and fire the instant they
      // come back — before a single chunk is processed — killing a perfectly
      // healthy 88 MB master and making withRetry restart it from byte zero on
      // venue Wi-Fi (the very app-switch pathology live-mode's audioSig guard was
      // written to eliminate). Coming back into view is not a stall: restart the
      // countdown instead of judging the freeze.
      const hasDoc = typeof document !== "undefined";
      const onVisible = () => {
        if (document.visibilityState === "visible") t.ping();
      };
      if (hasDoc) document.addEventListener("visibilitychange", onVisible);
      try {
        const res = await fetch(url, { signal: t.signal });
        if (!res.ok) throw new Error(`ดาวน์โหลดไฟล์เสียงไม่สำเร็จ (${res.status})`);
        // No stream to watch → plain whole-body read, bounded only by the flat
        // STALL window above (it can't be reset without chunk events).
        if (!res.body || typeof TransformStream === "undefined") return await res.blob();
        // Tap the body so the timeout becomes a NO-PROGRESS one: every chunk
        // restarts the clock, so a legitimately slow 88 MB master survives while a
        // stalled connection still gives up. The buffering stays inside Response
        // .blob() (as with res.blob() before) — chunks are never piled up in JS
        // heap — and Content-Type is carried over so playback still gets a typed
        // Blob.
        const type = res.headers.get("content-type");
        const tapped = res.body.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              t.ping();
              controller.enqueue(chunk);
            },
          })
        );
        return await new Response(
          tapped,
          type ? { headers: { "content-type": type } } : undefined
        ).blob();
      } finally {
        if (hasDoc) document.removeEventListener("visibilitychange", onVisible);
        t.done();
      }
    },
    3,
    700,
    signal
  );
}

export async function removeEventAudio(path: string): Promise<void> {
  // DELETE runs server-side (no presigned URL) so the browser needs no R2 CORS
  // entry for it and the key is re-validated against the session.
  const res = await fetch(`${endpointBase}${PRESIGN_ENDPOINT}`, {
    method: "POST",
    headers: await endpointHeaders(),
    body: JSON.stringify({ key: path, op: "delete" }),
  });
  if (!res.ok) throw new Error(`ลบไฟล์เสียงไม่สำเร็จ (${res.status})`);
}
