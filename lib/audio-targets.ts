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
 * An item's audio is its own legacy per-item file (`audio_path`) if present,
 * otherwise the file on its linked library song. Items with no audio are
 * dropped. Mirrors live-mode's `resolveItemAudio` so the cache keys/paths a
 * prefetch writes line up exactly with what Live Mode later reads.
 */
export function resolveAudioTargets(
  items: ResolvableItem[],
  songAudio: SongAudioMap
): PrefetchTarget[] {
  const out: PrefetchTarget[] = [];
  for (const it of items) {
    const sa = it.song_id ? songAudio[it.song_id] : undefined;
    const path = it.audio_path ?? sa?.path ?? null;
    if (!path) continue;
    const name = it.audio_name ?? sa?.name ?? "เพลง";
    out.push({ itemId: it.id, path, name });
  }
  return out;
}
