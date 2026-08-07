// Desktop-only source for the metronome's spoken 1–8 count samples.
//
// The web implementation (lib/count-samples.ts, which this file replaces via a
// Vite alias + a tsconfig path) fetches "/sounds/count/N.mp3" out of Next's
// public/. Neither half of that can work in the packaged desktop app:
//
//   • The bytes were never there. desktop/vite.config.ts has no publicDir and
//     desktop/public does not exist, so `vite build` emitted only assets/ and
//     index.html; electron-builder packaged exactly that. The mp3s sat in the
//     repo-root public/, which the desktop build never reads.
//   • A fetch could not have reached them anyway. electron/main.cjs loads the
//     renderer with win.loadFile(), i.e. a file:// document, and the Fetch API
//     supports no file: scheme — Chromium rejects file:// fetches outright,
//     absolute or relative. There is no registerFileProtocol in this app either.
//
// So the samples are BAKED INTO THE JS BUNDLE. Vite's `?inline` forces each mp3
// to a base64 data: URI in the emitted chunk, which we decode in memory: no
// request of any kind, no copy step to forget, and it survives a cold offline
// boot on the machine that travels to venues — which is the entire reason the
// desktop app exists. The eight files total ~73 KB (~97 KB as base64); that is
// a rounding error against the renderer bundle and buys an always-correct count.
//
// If you add a ninth sample, add it here too — a missing one makes the loader
// reject and the UI falls back to the honest "โหลดเสียงนับไม่ได้" notice rather
// than counting 1–8 with a hole in it.
import c1 from "../../../public/sounds/count/1.mp3?inline";
import c2 from "../../../public/sounds/count/2.mp3?inline";
import c3 from "../../../public/sounds/count/3.mp3?inline";
import c4 from "../../../public/sounds/count/4.mp3?inline";
import c5 from "../../../public/sounds/count/5.mp3?inline";
import c6 from "../../../public/sounds/count/6.mp3?inline";
import c7 from "../../../public/sounds/count/7.mp3?inline";
import c8 from "../../../public/sounds/count/8.mp3?inline";
// Relative import on purpose: "@/lib/count-samples" is aliased to THIS file, so
// importing the shared helpers by that specifier would be circular.
import { COUNT_SAMPLE_COUNT, decodeDataUri } from "../../../lib/count-samples";

// Re-exported unchanged so this module is a drop-in for the web one (the
// tsconfig path makes the desktop typecheck compare the two). EVERY export the
// web module has must be listed here, including ones the desktop shim has no
// opinion about: the alias replaces the module entirely, so an export missing
// from this line is a module-not-found in the desktop build only — the web
// typecheck stays green and you find out at `npm run build`.
export {
  COUNT_SAMPLE_COUNT,
  countSampleUrl,
  countSetIsComplete,
  countVoiceNote,
  decodeDataUri,
} from "../../../lib/count-samples";
export type { CountVoiceStatus } from "../../../lib/count-samples";

const SOURCES = [c1, c2, c3, c4, c5, c6, c7, c8];

/**
 * Same contract as the web loader: resolve with all eight decoded buffers, or
 * reject. All-or-nothing — a partial set would count 1–7 in the nice voice and
 * click on 8, an on-beat stutter nobody can describe in a bug report.
 *
 * The `fetch` fallback below is not dead code and should not be deleted: if a
 * future Vite version (or an `assetsInlineLimit` change) stops honouring
 * `?inline`, the import yields a plain "./assets/1-hash.mp3" URL instead of a
 * data URI. That fetch WILL fail under file://, and it is supposed to — it fails
 * loudly into the "โหลดเสียงนับไม่ได้" notice instead of pretending the cute
 * voice is playing. It also makes `npm run dev` (http://localhost:5273) work
 * either way.
 */
export async function loadCountSamples(fetchImpl?: typeof fetch): Promise<ArrayBuffer[]> {
  const get: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init));
  const buffers = await Promise.all(
    SOURCES.slice(0, COUNT_SAMPLE_COUNT).map(async (src) => {
      if (src.startsWith("data:")) return decodeDataUri(src);
      const res = await get(src);
      if (!res.ok) throw new Error(String(res.status));
      return res.arrayBuffer();
    })
  );
  if (buffers.length < COUNT_SAMPLE_COUNT || buffers.some((b) => b.byteLength === 0)) {
    throw new Error("count sample ว่างเปล่า");
  }
  return buffers;
}
