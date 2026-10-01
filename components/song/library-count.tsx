/**
 * The Library title's right slot (spec §G.5): "**16** เพลง · Seishin Kakumei" —
 * the count in Barlow, then whose songs these are (the band for a band account,
 * the label for a label-wide one). Shared by the web page, the desktop page and
 * the gallery harness so the three cannot drift.
 *
 * Capped and truncated: PageTitle's right slot does not shrink, so a long label
 * name would otherwise squeeze the 56 px LIBRARY heading on a 390 px phone.
 */
export function LibraryCount({ count, scope }: { count: number; scope?: string | null }) {
  return (
    <span className="block max-w-[11rem] pb-[2px] text-right text-[13px] leading-snug text-muted-foreground">
      <span className="num text-[17px] text-foreground">{count}</span> เพลง
      {scope && <span className="block truncate">{scope}</span>}
    </span>
  );
}
