// The third member of the family, and the one that had no home until now.
//
//   lib/auth-session.ts   "an empty read is not an empty table"
//   lib/write-guard.ts    "a write that reported no error but touched no row did not happen"
//   HERE                  A FAILED READ IS NOT A ZERO COUNT.
//
// postgrest-js does not throw. A 500, a 429, a statement timeout, a dead pooler
// and an aborted fetch all resolve as `{ data: null, error }`. So the idiom every
// board in this app was written with —
//
//     const rows = (res.data ?? []) as Row[];
//
// — silently converts "we could not find out" into "there are none", and then the
// page does arithmetic on it. On /overview that arithmetic is what the label runs
// the day off, and each of the four numbers lies in a different direction:
//
//   • a failed setlist_items read makes a COMPLETE show display "⚠ ขาด N", so an
//     Ar goes hunting for data that is already there;
//   • a failed songs read zeroes copyrightPending, so an UNREVIEWED song reads as
//     cleared and nobody triages it before the show;
//   • a failed schedule_items read blanks every stage/booth time on the board;
//   • a failed run_sequence read empties runOrderFestivals, which REMOVES the
//     "คุมคิว (Live)" entry from the date header — i.e. it takes staff's entry
//     point to the live show-caller away, mid-festival, with nothing on screen
//     saying anything went wrong.
//
// Zero of those show an error. That is the whole problem: an honest failure is
// recoverable (the user retries), a confident wrong number is not.
//
// The established cure is the one getEventBundle already uses: THROW. Next's
// (app) error boundary renders a retryable card with a digest, and the real cause
// goes to the server log next to that digest. See lib/queries.ts
// eventBundleReadFailure — readFailure() below is the same judgement generalised
// off the bundle, so any page can adopt it without inheriting the bundle's
// event-shaped labels.
//
// NOTE the deliberate asymmetry with keepOnUntrustedEmpty() further down. A
// SERVER render has no previous good answer to fall back on and no user gesture
// to attach a retry to, so failing loudly is the only honest move. A live CLIENT
// board does have something to lose, so there the rule is "keep what you have".
// Same invariant, two different right answers.
import { hasLiveSession } from "@/lib/auth-session";

/** The only part of a PostgREST response this module needs in order to judge it —
 *  deliberately structural, so a hand-rolled `{ data, error }` (app/(app)/overview
 *  readPaged) and a real PostgrestResponse both satisfy it. */
export type ReadOutcome = { error: { message?: string | null } | null };

/**
 * "Did every one of these reads actually happen?" — returns an Error to throw, or
 * null when all of them succeeded.
 *
 * `reads` is keyed by the HUMAN NAME of each part, because that key is what the
 * failure names: the server log (and `next dev`) says which part of the page
 * could not be read instead of printing a bare stack. Keys are Thai for the same
 * reason lib/queries.ts BUNDLE_PART_LABELS is.
 *
 * Three rules, and they are the entire contract:
 *   1. ONLY `.error` decides. A successful read that returned zero rows is a
 *      success — a brand-new festival really does have no running order yet, and
 *      that must stay indistinguishable from an empty table. Any version of this
 *      that also treats `[]` as suspicious would make every empty state on the
 *      site throw, which is a worse bug than the one being fixed.
 *   2. ALL OR NONE. One entry failing fails the whole call. A page that genuinely
 *      can tolerate a missing part should not pass that part in, rather than this
 *      rule being softened for everyone (the same split getEventRow made away
 *      from getEventBundle).
 *   3. An entry that is null/undefined was NOT ATTEMPTED (a read skipped because
 *      there was nothing to read — `ids.length ? … : …`) and is not a failure.
 *
 * Pure and exported so lib/read-guard.test.ts can pin the truth table with no DB.
 */
export function readFailure(
  reads: Record<string, ReadOutcome | null | undefined>,
  where?: string
): Error | null {
  const failed = Object.entries(reads).filter(([, r]) => !!r?.error);
  if (failed.length === 0) return null;

  const labels = failed.map(([label]) => label).join(", ");
  const detail = failed
    .map(([label, r]) => `${label}: ${r?.error?.message || "unknown error"}`)
    .join(" | ");
  const err = new Error(
    `อ่านข้อมูลไม่สำเร็จ (${labels}) — ลองใหม่อีกครั้ง ข้อมูลยังอยู่ครบ ` +
      `[${where ?? "read"} · ${detail}]`
  );
  // Named so a caller can branch on it (`err.name === "ReadFailedError"`) instead
  // of string-matching the Thai copy — which Next redacts in production anyway.
  err.name = "ReadFailedError";
  return err;
}

/**
 * The one-liner a Server Component uses: throw if any of these reads failed.
 *
 * `where` is REQUIRED and has no default, for the reason logBundleFailure's does
 * not (lib/queries.ts): the console line is the ONLY thing that ties the digest
 * the user reads off the error card to a cause in the Vercel log, and a caller
 * that inherits someone else's label sends the next reader to the wrong file.
 */
export function assertReadsSucceeded(
  where: string,
  reads: Record<string, ReadOutcome | null | undefined>
): void {
  const err = readFailure(reads, where);
  if (!err) return;
  // Next redacts a server-thrown message in production and shows the client only
  // a digest, so the cause has to be logged HERE or it is lost.
  console.error(`[CueIQ] ${where} read failed:`, err.message);
  throw err;
}

/**
 * The client-side half of the same invariant: "should I keep the rows I already
 * have instead of believing this empty answer?"
 *
 * A read can come back `{ data: [], error: null }` for two completely different
 * reasons. Either the table really is empty, or supabase-js signed the request
 * with the ANON key — which it does silently whenever getSession() hands back
 * null, and auth-js caches a failed refresh for about a minute, i.e. exactly the
 * window a venue reconnect or a phone waking from sleep lands in. RLS answers an
 * anon SELECT with zero rows AND NO ERROR. Indistinguishable, unless you ask auth
 * the same question supabase-js asked (lib/auth-session.ts hasLiveSession).
 *
 * Only worth asking when there is something to lose — hence `hadRows`. A
 * genuinely empty answer to a board that is already empty is both cheap and
 * correct to accept, and paying a getSession() round trip for it on every poll is
 * not.
 *
 * @param rows    the array the read returned. `null`/`undefined` means the call
 *                ERRORED, which is the caller's own error branch to own — same
 *                division of labour as write-guard's wroteNothing().
 * @param hadRows do we currently hold rows this empty answer would wipe out?
 * @returns true  → do NOT believe it; keep what is on screen.
 *
 * FOUR HAND-ROLLED COPIES OF THIS EXIST TODAY and are deliberately left alone in
 * this round (changing four live surfaces to prove a helper works is how a fix
 * becomes an incident):
 *   • components/event/event-run-status.tsx:107
 *   • components/notifications/notification-bell.tsx:141 and :222
 *   • components/event/run-order-builder.tsx:163 — which even defines its OWN
 *     private hasLiveSession() instead of importing lib/auth-session, and then
 *     re-reads once more before wiping, because the order it would wipe is what
 *     "นำเข้าจากเวทีวง" reads linked_event_id off (wipe it and the next import
 *     inserts every act a second time and broadcasts the duplicate).
 *   • desktop/src/data/event-bundle.ts:114 — the `reallyGone` check.
 * Fold them in one at a time, each with its own test.
 */
export async function keepOnUntrustedEmpty(
  rows: unknown[] | null | undefined,
  hadRows = true
): Promise<boolean> {
  if (!Array.isArray(rows) || rows.length > 0) return false;
  if (!hadRows) return false;
  return !(await hasLiveSession());
}
