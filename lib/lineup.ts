/** Who is on THIS show and who is not, in band order.
 *
 *  `chosen` false = nobody has been picked yet (0006_event_lineup.sql: an empty
 *  event_members set means "not chosen", not "nobody comes"). Every surface draws
 *  that as the whole band, so `absent` is empty then — which is exactly why a
 *  caller must SAY it was not chosen instead of letting the sheet imply a full
 *  turnout nobody confirmed.
 *
 *  Counts come from the member list, not `lineup.length`: a lineup row can outlive
 *  the member it points at, and "มา 8/7 คน" is a sentence nobody can act on. */
export function lineupStatus<M extends { id: string }>(
  members: M[],
  lineup: string[]
): { chosen: boolean; present: M[]; absent: M[] } {
  if (lineup.length === 0) return { chosen: false, present: members, absent: [] };
  const inLineup = new Set(lineup);
  return {
    chosen: true,
    present: members.filter((m) => inLineup.has(m.id)),
    absent: members.filter((m) => !inLineup.has(m.id)),
  };
}

export function memberLabel(m: { name: string; nickname: string | null }): string {
  return m.nickname?.trim() || m.name;
}
