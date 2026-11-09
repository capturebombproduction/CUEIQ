// Artists' "เรียงตามเลขไมค์" (2026-11-10; พี่ 2026-11-08, on Seishin's roster: "สลับตำแหน่งให้เรียงถูกต้องที").
// members.sort_order is the order a band's people stand in everywhere - Artists, a show's
// lineup, the Mic Map, the shared page - and nothing in the app could change it: a member
// added late stood last whatever mic they held, and the only cure was a script on the database.
import { hasLeft } from "@/lib/member-status";

type Row = { id: string; mic_number: number | null; sort_order: number; left_at?: string | null };

/**
 * ONE band's members put in mic order, as the sort_order each row should then carry (1, 2, 3 …):
 * today's roster by mic number, the people without a mic after them, the people who left the
 * band last - each of the three keeping the order it stood in (two people on one mic number do
 * not swap). Only the rows whose number changes come back; [] = nothing to do, which is also the
 * answer for a roster already standing in mic order on numbers with gaps in them (1, 2, 5).
 */
export function micOrderPlan(members: readonly Row[]): { id: string; from: number; to: number }[] {
  const was = members.map((m, i) => ({ m, i })).sort((a, b) => a.m.sort_order - b.m.sort_order || a.i - b.i);
  const rank = (m: Row) => (hasLeft(m) ? 2 : m.mic_number == null ? 1 : 0);
  const next = was
    .map(({ m }, at) => ({ m, at }))
    .sort((a, b) => rank(a.m) - rank(b.m) || (rank(a.m) === 0 ? a.m.mic_number! - b.m.mic_number! : 0) || a.at - b.at);
  const sameOrder = next.every((x, k) => x.at === k);
  const distinct = was.every((x, k) => k === 0 || x.m.sort_order > was[k - 1].m.sort_order);
  if (sameOrder && distinct) return [];
  return next.map(({ m }, k) => ({ id: m.id, from: m.sort_order, to: k + 1 })).filter((p) => p.from !== p.to);
}
