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

/** A setlist row whose song has NO online master (⭐#1 step 7). */
export interface LocalOnlyCandidate {
  itemId: string;
  /** The library song — the key lib/local-source.ts stores per-device bytes under. */
  songId: string;
  name: string;
}

/**
 * The rows resolveAudioTargets drops: linked to a library song that currently has
 * no online master at all. There is nothing to download for them, so they cannot
 * be prefetch TARGETS — but they are not nothing either, and treating them as
 * nothing is how a show gets a silent track behind a green readiness check.
 *
 * Two very different situations hide in here, and only the DEVICE can tell them
 * apart (lib/local-source.ts is IndexedDB; this file stays pure so a Server
 * Component can call it):
 *   • the song's only copy is a file picked on THIS device while offline, waiting
 *     in the upload queue — playable here right now (⭐#1 step 6 + 7);
 *   • the song genuinely has no audio anywhere — that row WILL be silent, and
 *     saying so before the show is the whole point of the preflight.
 * `name` is the row title, since a song with no file has no filename to show.
 */
export function resolveLocalOnlyCandidates(
  items: (ResolvableItem & { title?: string | null })[],
  songAudio: SongAudioMap
): LocalOnlyCandidate[] {
  const out: LocalOnlyCandidate[] = [];
  for (const it of items) {
    if (!it.song_id) continue; // unlinked legacy row: local-source has no key for it
    if (songAudio[it.song_id]?.path) continue; // has a master → a normal target
    out.push({ itemId: it.id, songId: it.song_id, name: it.title?.trim() || "เพลง" });
  }
  return out;
}
