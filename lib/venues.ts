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

/** Best-effort match of a typed venue name against the presets. */
export function findVenuePreset(
  name: string | null | undefined
): VenuePreset | undefined {
  if (!name) return undefined;
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  return VENUE_PRESETS.find(
    (v) =>
      v.name.toLowerCase() === n ||
      v.name.toLowerCase().includes(n) ||
      n.includes(v.name.toLowerCase())
  );
}
