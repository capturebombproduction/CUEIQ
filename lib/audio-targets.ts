// Pure helpers for figuring out which audio files an event needs on-device.
// Kept free of any browser/IndexedDB import so a Server Component (the event
// page) can resolve targets and pass them to the client prefetch UI.

export interface PrefetchTarget {
  itemId: string; // setlist item id — the on-device cache key is `${eventId}::${itemId}`
  path: string; // authoritative R2 object key for the current version
  name: string; // filename, for display
}

export type SongAudioMap = Record<
  string,
  { path: string | null; name: string | null }
>;

type ResolvableItem = {
  id: string;
  song_id?: string | null;
  audio_path?: string | null;
  audio_name?: string | null;
};

/**
 * Flatten a setlist into the list of audio files this event actually plays.
 * A library-linked item (song_id) plays its SONG's file; only an UNLINKED legacy
 * item uses its own `audio_path`. Items with no audio are dropped. The order here
 * mirrors live-mode's `resolveItemAudio` exactly — including the song winning over
 * a per-item path the row still carries — so the cache keys/paths a prefetch
 * writes line up with what Live Mode later reads. Preferring the item's own path
 * would target an R2 key Live Mode never asks for: a permanent red "ยังไม่พร้อม"
 * and a เตรียม that 404s forever.
 */
export function resolveAudioTargets(
  items: ResolvableItem[],
  songAudio: SongAudioMap
): PrefetchTarget[] {
  const out: PrefetchTarget[] = [];
  for (const it of items) {
    const sa = it.song_id ? songAudio[it.song_id] : undefined;
    const path = (it.song_id ? sa?.path : it.audio_path) ?? null;
    if (!path) continue;
    const name = (it.song_id ? sa?.name : it.audio_name) ?? "เพลง";
    out.push({ itemId: it.id, path, name });
  }
  return out;
}
