/*
 * THE FESTIVAL KEY — and why renaming an event could empty a whole festival's board.
 *
 * `run_sequence` (the festival running order: bands, games, MC, breaks — the thing staff
 * call the show from) is NOT keyed on an event id. It is keyed on
 *
 *     (tenant_id, event_name TEXT, event_date DATE)
 *
 * and that was deliberate: a "festival" is not one row in `events`, it is the SET of every
 * band's event that shares a name and a day. Migration 0033 says so in its own header. The
 * Overview groups festivals exactly the same way. There is no id to key on, because the
 * thing being keyed does not have one.
 *
 * The cost of that choice was never paid until round 10 found it: **nothing in the system
 * followed the key when it moved.** `event_name` is written when the board is BUILT and
 * never again — so one edit to an event's name or date silently detached that band from
 * the board, and:
 *
 *   · the band's run-status card read 0 rows — no countdown, no "ถึงคิวแล้ว"
 *   · /run-order opened EMPTY, and staff filling it in again created a SECOND board under
 *     the new name that none of the other bands could see
 *   · the live caller drove that empty/duplicate board instead of the real one
 *   · the Overview dropped that band out of the festival group
 *   · "เริ่มงาน" found no live row and did nothing at all, with no error
 *
 * and if the whole festival was moved to another DAY, the old board matched nothing at
 * all — no screen in the product could reach it again, to read or to delete.
 *
 * ⚖️ P'PATZ'S RULING (round 10): WARN, MAKE THEM CONFIRM, THEN FOLLOW THROUGH. Not a
 * block — renaming a show is an ordinary, legitimate thing to do, and forbidding it would
 * punish the typo-fixer for a schema decision they cannot see. Not a silent cascade
 * either: moving rows that the whole label is watching deserves a sentence first.
 *
 * ── 🔴 AND THEN "FOLLOW THROUGH" TURNED OUT TO BE UNIMPLEMENTABLE FROM THE CLIENT ─────
 *
 * TWO versions of the mover were written and both were killed by review, on the same night.
 *
 * The FIRST updated every `run_sequence` row under the old key. Re-read the key: the board
 * is shared by EVERY band's event with that name and date. So fixing a typo on ONE band's
 * event moved the whole festival's board out from under the other seven. The fix detached
 * N−1 bands where the bug detached one — strictly worse than the thing it repaired, and
 * written by someone who had just finished writing the header above explaining why the key
 * is shared.
 *
 * The SECOND demanded proof that the move was safe: "this event is the sole member of the
 * old key, and the destination is empty", computed from a count of sibling events. But
 * `events` SELECT is `can_view_group`, and the people who may rename an event are the
 * tenant admin and **the band's own Ar**. An Ar is not label-wide, so the other bands'
 * events are INVISIBLE to it and the sibling count comes back 0. The guard would have
 * concluded "sole member" for a genuinely shared eight-band festival and authorised exactly
 * the blanket move it existed to prevent — for the specific user the feature was for. A
 * proof that evaluates to "safe" precisely when it cannot see the danger is not a proof.
 *
 * ⚖️ SO THE BOARD IS NEVER MOVED. WARN, CONFIRM, WRITE NOTHING.
 *
 * That is a smaller feature than the ruling asked for, and it is the honest one. Renaming
 * was ALREADY detaching this event silently; the warning is the whole repair. What is given
 * up is a convenience in one case (a one-band festival); what is bought is that no rename
 * can ever take a running festival's board away from seven other bands, whoever presses it
 * and whatever RLS lets them see. It also costs ONE read instead of three, and that read
 * only affects WORDING — never a write — so a failed read degrades to a vaguer sentence
 * instead of to a dangerous decision.
 *
 * 📌 IF THE MOVE IS EVER WANTED AGAIN, it belongs on the SERVER, where the sibling count can
 * be taken with the tenant's full view (a SECURITY DEFINER function or an RPC), not in a
 * component reading through the caller's own RLS. Do not rebuild it on the client.
 *
 * This file is pure: no supabase, no React. The decision and the words live here so they can
 * be tested; the single read lives at the call site.
 */

/** The triple that identifies a festival board, minus the tenant. */
export interface FestivalKey {
  name: string;
  /** ISO `YYYY-MM-DD`, or null for a festival with no date set. */
  date: string | null;
}

/**
 * Normalise one side of the comparison the way the write path does.
 *
 * The form trims the name before saving (`name.trim()`), and an empty date field arrives as
 * `""` from an `<input type="date">` but is stored as NULL. Comparing raw values would
 * report a change for "  X " → "X" (there is none) and miss "" → null (there is none
 * either), and every false positive here costs the user a scary confirm dialog they did not
 * earn.
 */
export function normalizeFestivalKey(
  name: string | null | undefined,
  date: string | null | undefined
): FestivalKey {
  return {
    name: (name ?? "").trim(),
    date: date ? date : null,
  };
}

/** Do these two keys point at the same festival board? */
export function sameFestivalKey(a: FestivalKey, b: FestivalKey): boolean {
  return a.name === b.name && a.date === b.date;
}

/**
 * Does saving this edit move the event to a different festival board?
 *
 * Note what is NOT asked: whether a board EXISTS. That needs the database, it is the call
 * site's job, and it is asked second — there is no reason to query for rows on an edit that
 * does not move the key at all, which is nearly every edit.
 */
export function festivalKeyChanged(before: FestivalKey, after: FestivalKey): boolean {
  return !sameFestivalKey(before, after);
}

/** Which of the two halves of the key the user actually edited — for the Thai copy. */
function whatChanged(before: FestivalKey, after: FestivalKey): string {
  if (before.name !== after.name && before.date !== after.date) return "ชื่องานและวันที่";
  return before.name !== after.name ? "ชื่องาน" : "วันที่";
}

const keyLabel = (k: FestivalKey) => `“${k.name}”${k.date ? ` · ${k.date}` : ""}`;

/**
 * What the ONE read the call site takes says about how loudly to warn.
 *
 * `rows` = how many `run_sequence` rows sit under the OLD key, or `null` when that read
 * failed or was not attempted. Note what is deliberately NOT read any more: sibling events
 * and the destination board. Both existed to authorise a write, there is no write now, and
 * the sibling one was unreliable under RLS anyway — see the header.
 *
 * ⚠️ `null` is never treated as 0. A failed read still warns; it just cannot say how big the
 * board is. That is the entire cost of an unreadable count now, which is the point of having
 * removed the write.
 */
export type FestivalMovePlan =
  /** No board under the old key. Save normally, say nothing. */
  | { kind: "no-board" }
  /** A board exists and this event is about to stop being part of it. */
  | { kind: "detaches"; rows: number }
  /** Could not read the board. Warn without a number. */
  | { kind: "unknown" };

export function planFestivalMove(counts: { rows: number | null }): FestivalMovePlan {
  if (counts.rows === null) return { kind: "unknown" };
  if (counts.rows === 0) return { kind: "no-board" };
  return { kind: "detaches", rows: counts.rows };
}

/**
 * The Thai dialog for a plan. Returns null when there is nothing to ask.
 *
 * 🔤 THE COPY HAS ONE JOB: make the user understand that the board is keyed on the NAME AND
 * DAY, not on this event, before they change either. Everything else follows from that — why
 * the board does not come along, and why moving a whole festival means editing every event
 * in it.
 *
 * ⛔ Earlier drafts told staff to "go and fix it on the festival queue page". That is advice
 * the product cannot take: every run-order route is keyed on an event id and reads THAT
 * event's name and date, so a board under a key no event holds has no URL at all. Do not put
 * that sentence back.
 */
export function describeFestivalMovePlan(
  plan: FestivalMovePlan,
  before: FestivalKey,
  after: FestivalKey
): { title: string; description: string; confirmText: string } | null {
  if (plan.kind === "no-board") return null;
  const what = whatChanged(before, after);
  const rule =
    "บอร์ดคิวผูกกับ “ชื่องาน + วันที่” ไม่ได้ผูกกับตัวงาน และใช้ร่วมกันทุกวงในเทศกาลนั้น — " +
    "ระบบจึงไม่ย้ายบอร์ดให้ เพราะการย้ายตามวงเดียวจะดึงบอร์ดออกจากวงอื่นทั้งหมด";
  const howTo = "ถ้าตั้งใจย้ายทั้งเทศกาล ต้องแก้ชื่อ/วันของทุกงานในเทศกาลให้ตรงกัน";
  if (plan.kind === "unknown") {
    return {
      title: "งานนี้อาจหลุดจากบอร์ดคิวเทศกาล",
      description:
        `การแก้${what}จะทำให้งานนี้ไม่อยู่ในบอร์ดคิวเดิมอีก ` +
        `(ตอนนี้อ่านบอร์ดไม่ได้ เลยบอกจำนวนลำดับไม่ได้) — ${rule} · ${howTo}`,
      confirmText: "บันทึกต่อ",
    };
  }
  return {
    title: "งานนี้จะหลุดออกจากบอร์ดคิวเทศกาล",
    description:
      `บอร์ด ${keyLabel(before)} มี ${plan.rows} ลำดับ · ` +
      `การแก้${what}จะทำให้งานนี้ไปอยู่ที่ ${keyLabel(after)} และไม่เห็นบอร์ดเดิมอีก — ${rule} · ${howTo}`,
    confirmText: "เข้าใจแล้ว บันทึก",
  };
}
