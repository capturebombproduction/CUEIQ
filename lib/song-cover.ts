// Song cover art: a picture the user picks becomes a small square thumbnail stored on
// the song row as a data URL (supabase/migrations/0044_song_cover.sql says why on the
// row and not in R2). Everything here runs in the browser; the pure parts are exported
// for tests.

/** Edge of the stored square, in px. The library tile is 44 px, the sheet preview 96 px:
 *  192 is 2x the larger one, so it stays sharp on a retina phone and an iPad. */
export const COVER_PX = 192;

/** The database's ceiling (songs_cover_shape). A 192 px WebP / JPEG is ~8-25 K chars. */
export const COVER_MAX_CHARS = 60000;

/** What songs_cover_shape accepts - kept identical to the SQL so a cover the client
 *  makes can never be one the database refuses. */
export const COVER_SHAPE = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isCoverDataUrl(s: unknown): s is string {
  return typeof s === "string" && s.length <= COVER_MAX_CHARS && COVER_SHAPE.test(s);
}

/** The largest centred square of a w x h picture: what a cover shows of a photo. */
export function squareCrop(w: number, h: number): { sx: number; sy: number; side: number } {
  const side = Math.min(w, h);
  return { sx: Math.round((w - side) / 2), sy: Math.round((h - side) / 2), side };
}

/** Encodings to try, best first. Safari before 17 cannot ENCODE WebP and quietly hands
 *  back a PNG from toDataURL("image/webp") - that is caught by the type check. */
const ATTEMPTS: [type: string, quality: number][] = [
  ["image/webp", 0.82],
  ["image/jpeg", 0.85],
  ["image/webp", 0.65],
  ["image/jpeg", 0.7],
  ["image/jpeg", 0.55],
];

/** Pick the first encoding whose output is the type asked for and fits the ceiling. */
export function pickEncoded(encode: (type: string, quality: number) => string): string | null {
  for (const [type, quality] of ATTEMPTS) {
    const url = encode(type, quality);
    if (url.startsWith(`data:${type};`) && isCoverDataUrl(url)) return url;
  }
  return null;
}

async function decode(file: Blob): Promise<{ img: CanvasImageSource; w: number; h: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      return { img: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    } catch {
      /* some formats only an <img> can open (e.g. HEIC on Safari): fall through */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

/** A user's picture -> the cover to store. Throws a Thai message the UI can show. */
export async function makeCoverDataUrl(file: Blob): Promise<string> {
  if (file.type && !file.type.startsWith("image/")) throw new Error("ไฟล์นี้ไม่ใช่รูปภาพ");
  let pic: Awaited<ReturnType<typeof decode>>;
  try {
    pic = await decode(file);
  } catch {
    throw new Error("เปิดรูปนี้ไม่ได้ — ลองเป็นไฟล์ JPG หรือ PNG");
  }
  try {
    if (!pic.w || !pic.h) throw new Error("เปิดรูปนี้ไม่ได้ — ลองเป็นไฟล์ JPG หรือ PNG");
    const canvas = document.createElement("canvas");
    canvas.width = COVER_PX;
    canvas.height = COVER_PX;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("เครื่องนี้ย่อรูปไม่ได้");
    const { sx, sy, side } = squareCrop(pic.w, pic.h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(pic.img, sx, sy, side, side, 0, 0, COVER_PX, COVER_PX);
    const out = pickEncoded((type, quality) => canvas.toDataURL(type, quality));
    if (!out) throw new Error("ย่อรูปให้เล็กพอไม่ได้ — ลองรูปอื่น");
    return out;
  } finally {
    pic.close();
  }
}
