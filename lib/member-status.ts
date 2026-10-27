// A member who has left the band (members.left_at, migration 0054) is kept, not deleted:
// deleting cascaded them out of every past lineup and the practice attendance history
// (2026-10-27, พี่: "ทำสถานะ ออกจากวงแล้ว ให้สมาชิกแทนการลบ").
//
// The rule, the same as get_shared_event's in 0054: a left member still belongs to a show
// dated on or before their leaving day (Bangkok) and to any show whose lineup holds them;
// not to later shows, not to a show with no date, and not to the pickers of today's roster
// (Artists' head count, Overview, practice attendance).
import { bkkTodayKey } from "@/lib/time";

type Leaver = { left_at?: string | null };

/** True once the member has left the band. Rows read before 0054 have no field: in the band. */
export function hasLeft(m: Leaver): boolean {
  return !!m.left_at;
}

/** The Bangkok calendar day the member left, as "YYYY-MM-DD" (null while in the band). */
export function leftOnKey(m: Leaver): string | null {
  if (!m.left_at) return null;
  const t = new Date(m.left_at);
  return Number.isNaN(t.getTime()) ? null : bkkTodayKey(t);
}

/** Today's roster: the members who have not left. */
export function currentMembers<M extends Leaver>(members: readonly M[]): M[] {
  return members.filter((m) => !hasLeft(m));
}

/**
 * The band as it stood for ONE show: everyone still in it, plus a left member when the show
 * is dated on or before their leaving day or its lineup holds them. `lineup` is the show's
 * event_members ids as LOADED - a left member taken off it during the edit stays on screen
 * until the next load rather than vanishing under the finger.
 */
export function membersForShow<M extends Leaver & { id: string }>(
  members: readonly M[],
  show: { eventDate: string | null | undefined; lineup?: Iterable<string> }
): M[] {
  const lineup = new Set(show.lineup ?? []);
  return members.filter((m) => {
    const left = leftOnKey(m);
    if (left === null) return true;
    if (lineup.has(m.id)) return true;
    return !!show.eventDate && show.eventDate <= left;
  });
}
