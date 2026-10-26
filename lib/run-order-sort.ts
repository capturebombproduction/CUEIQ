/**
 * The one order of a running order's rows: sort_order, then id.
 *
 * Two rows CAN share a sort_order (two staff screens adding at once used to give
 * both new rows the same number). Postgres hands ties back in no promised order,
 * so sorting on sort_order alone let the builder, the show caller and the status
 * strip each see the tied rows differently - and the caller's "next = the first
 * pending row with a HIGHER number" skipped the act tied with the live one. Every
 * screen sorts with this, and walks rows by position, never by "number > live".
 */
export function compareRunOrder(
  a: { sort_order: number; id: string },
  b: { sort_order: number; id: string }
): number {
  return a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** True when two rows share a sort_order (after sorting with compareRunOrder). */
export function hasRunOrderTie(sorted: readonly { sort_order: number }[]): boolean {
  return sorted.some((r, k) => k > 0 && r.sort_order === sorted[k - 1].sort_order);
}
