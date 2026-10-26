// ---------------------------------------------------------------------------
// Venue presets + Google Maps URL helpers (no API key, no cost).
//
// Frequent venues are kept here as data ("update into the app") so typing a
// known place auto-fills its map link. The embed/search URLs work without a
// Maps API key.
// ---------------------------------------------------------------------------

export interface VenuePreset {
  name: string; // short label shown in the venue field
  address?: string; // fuller address line for the summary
  mapUrl: string; // canonical Google Maps link
}

/** Frequently-used venues. Add new ones here as the team plays more places. */
export const VENUE_PRESETS: VenuePreset[] = [
  {
    name: "Lot of Live (Bangkok)",
    address: "Lot Of Live | AT Phenix Pratunam",
    mapUrl: "https://maps.app.goo.gl/DHPdAWzxqi7XLFdm7",
  },
];

/** iframe src for an embedded preview — works without an API key. */
export function mapsEmbedUrl(query: string): string {
  return `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
}

/** Clickable "open in Google Maps" link for a free-text place. */
export function mapsSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    query
  )}`;
}

/** Shortest typed start of a preset name that counts as that preset ("Lot " yes, "T" no). */
const MIN_PREFIX = 4;

/**
 * Best-effort match of a typed venue name against the presets: the typed text
 * names the preset ("Lot of Live", "Lot of Live (Bangkok) ชั้น 5") or is the start
 * of it, at least MIN_PREFIX characters long. Not "the preset contains what was
 * typed": the event form calls this on every key, and the first key of ANY venue
 * ("T" of "The Street") is inside "Lot of Live (Bangkok)" - its map link was filled
 * into shows at other venues.
 */
export function findVenuePreset(
  name: string | null | undefined
): VenuePreset | undefined {
  if (!name) return undefined;
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  return VENUE_PRESETS.find((v) => {
    const full = v.name.toLowerCase();
    const core = full.replace(/\s*\(.*\)\s*$/, ""); // "lot of live"
    return (
      n.includes(full) ||
      n.includes(core) ||
      (n.length >= MIN_PREFIX && full.startsWith(n))
    );
  });
}
