/**
 * The ถ่ายรูป rounds of one event, as the Overview shows them.
 *
 * Mig 0042 allows several photo rows per event as long as each round has its own
 * NAME; an unnamed row and one named "ถ่ายรูป" are the same round (its unique key is
 * `coalesce(nullif(btrim(label), ''), 'ถ่ายรูป')`). The Overview used to take
 * `find(kind === "photo")` over rows ordered by uuid: with two rounds the board and
 * the crew JPG showed ONE of them at random, and the inline photo editor wrote into
 * whichever that was - typing "the" photo time could overwrite "รอบ 2".
 *
 * main = the unnamed/"ถ่ายรูป" round, else the earliest; it is the one the inline
 * editor edits and the board sorts on. more = every other round, earliest first.
 */
export interface PhotoRow {
  id: string;
  kind: string;
  label?: string | null;
  start_time: string | null;
  end_time: string | null;
  sort_order: number;
}

export interface PhotoRound {
  start: string | null;
  end: string | null;
  label: string | null;
}

export const DEFAULT_PHOTO_LABEL = "ถ่ายรูป";

/** A photo row's round, as 0042's unique index keys it: blank = "ถ่ายรูป". */
export function photoRoundKey(label: string | null | undefined): string {
  return (label ?? "").trim() || DEFAULT_PHOTO_LABEL;
}

export function isMainPhotoRound(row: Pick<PhotoRow, "label">): boolean {
  return photoRoundKey(row.label) === DEFAULT_PHOTO_LABEL;
}

export function photoRoundsOf<T extends PhotoRow>(
  rows: readonly T[]
): { main: T | null; more: PhotoRound[] } {
  const photos = rows
    .filter((r) => r.kind === "photo")
    .sort(
      (a, b) =>
        (a.start_time ?? "￿").localeCompare(b.start_time ?? "￿") ||
        a.sort_order - b.sort_order
    );
  if (photos.length === 0) return { main: null, more: [] };
  const mainAt = Math.max(0, photos.findIndex(isMainPhotoRound));
  const main = photos[mainAt];
  const more = photos
    .filter((_, i) => i !== mainAt)
    .map((r) => ({
      start: r.start_time,
      end: r.end_time,
      label: (r.label ?? "").trim() || null,
    }));
  return { main, more };
}
