// The metronome's spoken 1–8 count ("เสียงสาวญี่ปุ่น") — where the samples come
// from, and why that differs between the web build and the desktop build.
//
// THE INCIDENT (round 10 sweep, 2026-08-07). components/practice/metronome.tsx
// defaults its sound mode to "voice" and used to fetch the eight samples with a
// root-absolute URL: fetch("/sounds/count/1.mp3"). That is correct on the web —
// they are served straight out of Next's public/sounds/count/ — but the desktop
// app was shipping NONE of it, and could not have loaded it even if it had:
//
//   1. desktop/vite.config.ts declares no publicDir and desktop/public does not
//      exist, so `vite build` emitted only assets/ + index.html. The mp3 bytes
//      lived exclusively in the repo-root public/, which the desktop build never
//      looked at. electron-builder's files list ("dist/**/*", "electron/**/*")
//      then packaged exactly that.
//   2. Even with the bytes on disk, the packaged renderer is loaded with
//      win.loadFile(), i.e. a file:// document. A root-absolute path there means
//      file:///sounds/count/1.mp3, and — more fundamentally — the Fetch API has
//      no file: scheme at all: Chromium rejects EVERY file:// fetch, relative or
//      not. So no amount of path fixing alone would have worked.
//
// The failure was silent by construction: the catch swallowed it, the decode
// bailed on a short array, and scheduleBeat fell through to live
// speechSynthesis fired from a setTimeout — the laggy path these recordings
// exist to replace. The mode pill kept reading "เสียงสาวญี่ปุ่น" the whole time,
// so the band rehearsed to a count that was off the beat with nothing on screen
// explaining why. On the machine that travels to venues, no less.
//
// THE FIX, in two halves:
//   • This module is the WEB implementation (plain fetch of the public/ URL).
//     desktop/src/shims/count-samples.ts is the desktop implementation, which
//     imports the same eight mp3s as `?inline` Vite assets so they are baked
//     into the JS bundle as data: URIs — no file:// request, nothing to copy,
//     works on a cold offline boot. A Vite alias + a tsconfig path swap the two,
//     exactly the mechanism already used for "@/lib/supabase/client".
//   • countVoiceNote() below closes the honesty gap: if the samples did not
//     load, the UI must stop claiming the cute voice is what you are hearing.
//
// NOTE FOR THE NEXT READER: an older comment in metronome.tsx claimed the
// service worker cached these "so they're on-device". It does not — public/sw.js
// has been VERSION "v8-push-only" since the bd7858a slim-down: no fetch handler
// at all, and its activate step deletes every cueiq-* cache. On the web that is
// deliberate (offline running moved to the desktop app), so do not "restore" it;
// just don't believe any comment that says these are cached in the browser.

/** The count is dance-studio style: eight samples, "one" … "eight". */
export const COUNT_SAMPLE_COUNT = 8;

/** Web URL of sample `n` (1-based). Root-absolute on purpose: the practice page
 *  lives at several depths (/practice, /events/:id/practice) so a relative path
 *  would resolve differently per route. */
export function countSampleUrl(n: number): string {
  return `/sounds/count/${n}.mp3`;
}

/**
 * Decode a `data:...;base64,....` URI to raw bytes.
 *
 * Used by the desktop shim on the strings Vite's `?inline` produces. It lives
 * here rather than in the shim so it is covered by lib tests — the shim itself
 * is desktop-only and outside the vitest include glob.
 *
 * Throws on anything that is not a base64 data URI, deliberately: the caller
 * treats that as "samples unavailable" and the UI then says so, which is far
 * better than silently handing the decoder a bogus buffer.
 */
export function decodeDataUri(uri: string): ArrayBuffer {
  const comma = uri.indexOf(",");
  if (!uri.startsWith("data:") || comma < 0) {
    throw new Error("ไม่ใช่ data URI");
  }
  // ";base64" may sit anywhere in the media-type parameter list, but it must be
  // there: a percent-encoded (non-base64) data URI would silently decode to junk.
  const meta = uri.slice("data:".length, comma);
  if (!/;base64\b/i.test(meta)) {
    throw new Error("data URI ไม่ได้เข้ารหัสแบบ base64");
  }
  const bin = atob(uri.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Load all eight count samples, ALL-OR-NOTHING.
 *
 * Partial success is worse than failure here: the scheduler picks a sample per
 * beat index, so seven-of-eight would give a count that speaks 1–7 in the nice
 * voice and clicks on 8 — an on-beat stutter the operator would chase for ages.
 * One missing sample therefore rejects the whole load and the caller shows the
 * fallback notice.
 *
 * `fetchImpl` is injectable only so the tests can drive it; app code calls it
 * with no arguments. When omitted we call the global through a wrapper rather
 * than defaulting the parameter to `fetch` itself — the same rule the desktop
 * Supabase shim follows: resolve fetch at CALL time, never capture the function
 * reference at module-eval time, so nothing that patches it later is bypassed
 * and no detached-method binding question can arise.
 */
export async function loadCountSamples(fetchImpl?: typeof fetch): Promise<ArrayBuffer[]> {
  const get: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init));
  const buffers = await Promise.all(
    Array.from({ length: COUNT_SAMPLE_COUNT }, async (_, i) => {
      const res = await get(countSampleUrl(i + 1));
      if (!res.ok) throw new Error(String(res.status));
      return res.arrayBuffer();
    })
  );
  // Belt and braces: a mocked/patched fetch that resolves to an empty body would
  // otherwise hand the AudioContext a zero-length buffer, which decodes to
  // silence — a metronome that "works" but makes no sound is the one bug report
  // nobody can describe. Treat it as a failed load instead.
  if (buffers.some((b) => b.byteLength === 0)) {
    throw new Error("count sample ว่างเปล่า");
  }
  return buffers;
}

/**
 * Does a DECODED set obey the same all-or-nothing rule loadCountSamples()
 * enforces on the bytes?
 *
 * The loader can only vouch for the bytes. Every AudioContext then has to decode
 * them for itself, and THAT can come back partial — a codec the platform refuses,
 * or (far more often) a context closed underneath the decode loop. The metronome
 * stored that partial array straight into the scheduler's per-beat lookup, which
 * gives a count that speaks 1–6 in the recorded voice and clicks on 7–8: exactly
 * the stutter the prose above forbids on the load path. The rule therefore has to
 * be applied where the decode PUBLISHES too, and it lives here so it has a test
 * — the component itself is outside the vitest include glob. (round 10 review,
 * 2026-08-08.)
 *
 * THERE IS A THIRD CALLER, and enforcing only the two above is not enough: the
 * scheduler READS the decoded set once per beat, so a bar that straddles the
 * publish still counted beat 1 in the fallback voice and 2–8 in the recording.
 * components/practice/metronome.tsx therefore calls this at every downbeat and
 * latches the answer for that whole bar (scheduleBeat + startScheduler). If you
 * change what "complete" means here, that latch is what the band hears.
 * (review wave 2, 2026-08-08.)
 *
 * Two things this deliberately does NOT delegate to Array.every, both of them
 * the same mistake in different clothes — reading "could not check" as "nothing
 * wrong":
 *   • the length check, because [].every(Boolean) is TRUE, so a set that came
 *     back short would otherwise be announced as ready;
 *   • the loop, because `every` SKIPS HOLES. A sparse array of length 8 built by
 *     index writes that never happened passes every(Boolean) — the check the
 *     metronome shipped with. Indexing by beat, a hole is indistinguishable from
 *     a null, so it has to count as missing. The test for this failed the first
 *     time it was run.
 */
export function countSetIsComplete(decoded: readonly unknown[]): boolean {
  if (decoded.length !== COUNT_SAMPLE_COUNT) return false;
  for (let i = 0; i < COUNT_SAMPLE_COUNT; i++) {
    if (!decoded[i]) return false;
  }
  return true;
}

/** Where the spoken count currently stands, from the component's point of view. */
export type CountVoiceStatus = "loading" | "ready" | "unavailable";

/**
 * The line printed next to the "นับ 1–N 🎀" mode button.
 *
 * THE POINT OF THIS FUNCTION is that "voice mode is selected" and "the voice you
 * were promised is what you will hear" are two different facts, and the UI used
 * to only ever state the first one. When the samples are missing the metronome
 * still counts — via the platform's own TTS voice, which fires from a timer and
 * lands late, or via a plain click if the machine has no voice installed — and
 * the operator is entitled to know that BEFORE spending the rehearsal wondering
 * why the count sits behind the beat.
 */
export function countVoiceNote(status: CountVoiceStatus, canSpeak: boolean): string {
  if (status === "ready") return "เสียงสาวญี่ปุ่น";
  if (status === "loading") return "กำลังโหลดเสียงนับ…";
  return canSpeak
    ? "โหลดเสียงนับไม่ได้ — ใช้เสียงอ่านของเครื่องแทน อาจตกจังหวะเล็กน้อย"
    : "โหลดเสียงนับไม่ได้ — ใช้เสียงคลิกแทน";
}
