/**
 * "2026-10-04" → { wd: "Sun", day: "04", mon: "Oct", year: "2026" } — the pieces
 * the ticket, the event stubs and the event hero's day tile set in display type.
 *
 * Parsed AND formatted in UTC, so the server (Vercel runs UTC) and a Bangkok
 * browser print the same day: a date-only key has no time zone, and reading it as
 * local midnight then formatting it in another zone is how a show moves a day.
 * en-US, not en-GB: en-GB prints September as "Sept", one letter wider than every
 * other month on a tile sized for three.
 *
 * null for a missing or garbled key — a cached row can come without event_date
 * (the desktop's offline list), and the old formatter printed the raw string.
 */
export function dateParts(key: string | null | undefined) {
  if (!key) return null;
  const d = new Date(`${key}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const f = (o: Intl.DateTimeFormatOptions) =>
    d.toLocaleDateString("en-US", { timeZone: "UTC", ...o });
  return {
    wd: f({ weekday: "short" }),
    day: f({ day: "2-digit" }),
    mon: f({ month: "short" }),
    year: f({ year: "numeric" }),
  };
}
