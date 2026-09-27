import type { Song } from "@/lib/types";

// "ซ้อมตามเซ็ตลิสต์" — measured 2026-09-28: Seishin Kakumei's practice runs
// (88 of them, 16 days) are, rehearsal after rehearsal, the NEXT show's setlist
// in that show's order — 25 Sep = the 27 Sep set, 18/19 Sep = the 19/20 Sep sets.
// The player only ever played one song and stopped, so a run-through meant finding
// each next song in the room's list by hand, between songs, mid-rehearsal. These
// two helpers pick the show and turn its setlist into a play queue.

export type SetlistRow = {
  id: string;
  title: string | null;
  kind: string;
  song_id: string | null;
  sort_order: number;
};

export type SetlistShow = {
  id: string;
  name: string;
  event_date: string;
  setlist_items: SetlistRow[];
};

/**
 * Shows worth rehearsing, best guess first: upcoming ones soonest-first (the one
 * the band is rehearsing for), then the recent past latest-first (with nothing
 * entered yet, the last show is the next one with two songs swapped). Shows with
 * no linked song at all have nothing to play and are left out.
 */
export function orderShowsForPractice(
  shows: SetlistShow[],
  today: string,
  max = 8
): SetlistShow[] {
  const playableShows = shows.filter((s) => s.setlist_items.some((r) => r.song_id));
  const upcoming = playableShows
    .filter((s) => s.event_date >= today)
    .sort((a, b) => a.event_date.localeCompare(b.event_date));
  const past = playableShows
    .filter((s) => s.event_date < today)
    .sort((a, b) => b.event_date.localeCompare(a.event_date));
  return [...upcoming, ...past].slice(0, max);
}

export type QueueEntry = { itemId: string; song: Song };

/**
 * The show's playable songs in running order. A row with no song link (MC,
 * ถ่ายรูป, a title typed but never linked to the library) is not something to
 * play and is skipped; a SONG row that can't play — unlinked, or linked to a
 * song with no audio — is listed in `missing` so the card can say what the run
 * will leave out rather than silently shortening the set.
 */
export function setlistQueue(
  show: SetlistShow,
  songsById: Map<string, Song>,
  playable: (s: Song) => boolean
): { queue: QueueEntry[]; missing: string[] } {
  const queue: QueueEntry[] = [];
  const missing: string[] = [];
  const rows = show.setlist_items.slice().sort((a, b) => a.sort_order - b.sort_order);
  for (const row of rows) {
    const song = row.song_id ? songsById.get(row.song_id) : undefined;
    if (song && playable(song)) {
      queue.push({ itemId: row.id, song });
    } else if (row.song_id || row.kind === "song") {
      missing.push(song?.title ?? row.title?.trim() ?? "—");
    }
  }
  return { queue, missing };
}
