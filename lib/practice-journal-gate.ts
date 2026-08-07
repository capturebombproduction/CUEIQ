// ---------------------------------------------------------------------------
// The UI mirror of practice_logs' RLS — "may this account write in THIS band's
// สมุดซ้อม?"
//
// Why this exists at all: migration 0041 rescoped practice_logs_insert from
// `can_view_group(group_id)` to `can_edit_group(group_id) OR a group_roles row
// for that band`. `can_view_group` is true for every label-wide role (admin /
// ceo / label_staff) by design — they SEE every band — so before 0041 a CEO
// could author journal entries in any band's practice room, and 0041 closed
// that. What 0041 could not do is tell the UI. The journal kept rendering its
// composer to a CEO, who typed a note, pressed บันทึก and got the raw English
// PostgREST policy message inside a Thai screen. lib/permissions.ts states the
// contract these helpers serve: "these are for the UI to hide/show controls so
// users aren't offered actions the DB will reject."
//
// The same shape was already fixed once next door — commit 951b4fe, "don't
// offer a homework tick that RLS will always bounce" — and components/practice/
// practice-mode.tsx computes the same flag (its `canCurate`) for the PLAYER half
// of the room from an identical group_roles probe.
//
// BOTH halves call these functions. That is not decoration: the player half used
// to end its probe with `setInThisBand(data.length > 0)`, which turns an empty
// read straight into "not a member" — so during the ~minute supabase-js spends
// answering with the anon key after a failed token refresh, a genuine member of
// the band watched the add-song / reorder / marker controls disappear from the
// เครื่องเล่น tab while the สมุดซ้อม tab (which already used membershipFromProbe)
// kept their composer. One user, one screen, two opposite verdicts, and the tab
// that got it wrong failed CLOSED. If someone later lifts the probe into the
// parent so both halves share one read, delete the duplicate probe in
// practice-journal.tsx and pass the answer down — but keep calling THESE
// functions, because they are the only written-down copy of what 0041/0038/0024
// actually permit.
//
// Note the player half gates practice_songs / song_markers, whose write clause
// (0038 §2 C13) is character-for-character the one 0041 gave practice_logs_insert
// — editor OR a group_roles row — which is why canWriteJournal answers for it too
// despite the name.
//
// NOTE ON `canManage`: throughout the practice components `canManage` means
// canEditGroup(perms, groupId) — admin, or the band's Ar. It is NOT "is a
// member of this band" (it is false for plain members) and it is NOT
// "label-wide" (it is false for a ceo/label_staff with no group_roles row).
// That is precisely why it cannot be the whole gate on its own.
// ---------------------------------------------------------------------------

/**
 * What we know about "does this user hold a group_roles row in this band?".
 *
 * `unknown` is a real, load-bearing state, not a placeholder: the probe is an
 * async read that can still be in flight, or can fail outright at a venue with
 * no signal. We must FAIL OPEN there — a band member standing in a rehearsal
 * room must never be locked out of their own journal because a membership read
 * timed out. RLS remains the actual boundary; this only decides what to render.
 */
export type BandMembership = "unknown" | "in-band" | "outsider";

/**
 * May this account INSERT a practice_logs row for this band?
 * Mirrors 0041's practice_logs_insert: editor OR band member.
 * (The `author_id = auth.uid()` clause is always satisfied — the composer only
 * ever writes the current user's own id.)
 */
export function canWriteJournal(
  canManage: boolean,
  membership: BandMembership
): boolean {
  if (canManage) return true; // can_edit_group → admin or this band's Ar
  return membership !== "outsider"; // unknown fails OPEN, see the type's doc
}

/**
 * May this account change a given log row — tick its homework, or delete it?
 *
 * Mirrors WHO may write: `author_id = auth.uid() OR can_edit_group(group_id)` —
 * that is 0024's practice_logs_delete verbatim, and the USING half of
 * practice_logs_update as 0038 §P5 recreated it. ⚠️ UPDATE is NO LONGER identical
 * to DELETE: §P5 added a WITH CHECK — `can_view_group(group_id) AND (visibility =
 * 'shared' OR can_edit_group(group_id))` — so an author can no longer move their
 * own note into another band or promote it to staff-only. This helper is still
 * the right gate for the homework tick ONLY because toggleDone writes just
 * `done` + `updated_at`: group_id, event_id and visibility never move, so the
 * WITH CHECK is satisfied in every state the tick is reachable from (member on
 * 'shared', Ar on 'staff', pre-0041 CEO on their own 'shared'). If you ever reuse
 * canModifyLog for a write that touches visibility or moves a note between
 * bands/events, it is NOT sufficient — check §P5's WITH CHECK yourself.
 *
 * Note this is NOT the insert rule: band membership does not appear here, so a
 * plain member may write a note but may not tick a note someone else wrote.
 * Used for BOTH homework checkboxes in the journal — the carry-over list at the
 * top already had this gate; the one in the dated history did not, so anyone
 * could tick another member's homework and watch it flip back with an error.
 */
export function canModifyLog(canManage: boolean, isAuthor: boolean): boolean {
  return canManage || isAuthor;
}

/**
 * Resolve what an empty/errored membership probe should be recorded as.
 * Kept here (rather than inline in the effect) because it encodes the rule from
 * lib/auth-session.ts: an empty read is NOT an empty table. supabase-js falls
 * back to the anon key for about a minute after a failed token refresh, and RLS
 * answers an anon request with `data: [], error: null` — indistinguishable from
 * "you are not in this band". Treating that as `outsider` would hide a member's
 * own composer for the exact minute a venue reconnect lands in.
 *
 * @param rows      how many group_roles rows came back (null = the read failed)
 * @param signedIn  whether the request that produced `rows` really went out signed
 */
export function membershipFromProbe(
  rows: number | null,
  signedIn: boolean
): BandMembership {
  if (rows === null) return "unknown"; // read failed — we learned nothing
  if (rows > 0) return "in-band";
  if (!signedIn) return "unknown"; // empty, but possibly an anon answer
  return "outsider";
}

/**
 * Postgres insufficient_privilege (42501) — an RLS policy refused the write.
 *
 * Why the gate needs this: canWriteJournal FAILS OPEN on `unknown`, and it must
 * (a member in a rehearsal room with no signal keeps their own composer). The
 * cost of failing open is that an outsider whose probe never resolved still gets
 * the composer, types a coaching note, and is refused by 0041 — which is the
 * ORIGINAL bug this file was written to kill: the raw English policy text
 * (`new row violates row-level security policy for table "practice_logs"`) as the
 * body of a Thai toast. Hiding the composer made that rarer, not gone.
 *
 * So the refusal itself is treated as a probe result. It is a better one than the
 * probe: the policy answered in person. The caller says it in Thai and feeds
 * `outsider` back into `membership`, which collapses the composer into the
 * read-only panel — without it the probe is one-shot and the same person can
 * retype the same note and be refused forever with no explanation.
 *
 * Same shape as lib/mgmt-outbox.ts' isUniqueViolation: match the code, and fall
 * back to the message because a PostgREST error reaching us through a queue or a
 * re-thrown Error can arrive with the code stripped.
 */
export function isRlsRefusal(
  code: string | null | undefined,
  message: string | null | undefined
): boolean {
  if (code === "42501") return true;
  return !!message && /row-level security policy/i.test(message);
}

/**
 * The twin of membershipFromProbe, for the OTHER direction: what a refused write
 * proves about membership. It exists because the first cut of the refusal path
 * did not have it, and the asymmetry cost a real member their composer.
 *
 * membershipFromProbe already refuses to read a hostile-looking answer as
 * "outsider" unless the request went out signed. The refusal path believed the
 * same class of answer unconditionally, and 42501 is MORE likely to be an
 * anon-fallback artefact than an empty read is: `anon` holds no table privileges
 * on practice_logs at all (0026 grants only to `authenticated`), so during the
 * ~minute supabase-js spends substituting the anon key after a failed token
 * refresh, EVERY insert on this screen comes back `permission denied for table
 * practice_logs`, SQLSTATE 42501 — which isRlsRefusal matches on the code. A
 * genuine member (or the band's own Ar) pressing บันทึก in that window was told
 * "จดได้เฉพาะ Ar และเมมเบอร์ของวงนี้", the composer unmounted under them, and
 * since `membership` is written nowhere else for the life of the mount there was
 * no way back — the note they had just typed had nowhere to go.
 *
 * AN RLS REFUSAL DURING THE ANON-FALLBACK WINDOW IS NOT PROOF OF ANYTHING.
 *
 * Returns `null` for "learned nothing" rather than "unknown" on purpose: the
 * caller must leave `membership` exactly as it was. Downgrading a known
 * "in-band" to "unknown" would not change canWriteJournal today (both keep the
 * composer), but it would throw away a signed probe's answer on the strength of
 * an unsigned one, which is the same mistake one level down.
 *
 * A refusal can never prove the opposite, which is why the return type has no
 * "in-band": the policy only ever says no.
 *
 * @param refused   isRlsRefusal(code, message) for the failed write
 * @param signedIn  whether that write demonstrably went out signed (hasLiveSession)
 */
export function membershipFromRefusal(
  refused: boolean,
  signedIn: boolean
): "outsider" | null {
  if (!refused) return null; // some other failure — says nothing about membership
  if (!signedIn) return null; // anon-fallback: the policy answered the ANON key
  return "outsider";
}

/**
 * Does this failure look like it never reached the server? supabase-js puts the
 * TypeError text of a dead fetch straight into `message`, which is the only signal
 * we get — there is no status here.
 *
 * The word list is the repo's existing network test (lib/mgmt-outbox.ts's
 * isQueueableWriteError). Kept as a local copy rather than imported because that
 * function answers a different question ("should this write be queued?") and
 * folds in onLine/status; if the raw predicate is ever exported, import it here
 * and delete this one.
 */
function isTransportFailure(message: string | null | undefined): boolean {
  return (
    !!message &&
    /failed to fetch|fetch failed|load failed|network|err_internet|err_network|err_connection|timed? ?out|abort/i.test(
      message
    )
  );
}

/**
 * One Thai sentence for a failed write on this screen — so `error.message` never
 * reaches the UI again.
 *
 * The bug this file was created to remove was `new row violates row-level
 * security policy for table "practice_logs"` sitting inside a Thai toast. The
 * first repair took it out of addLog only; the journal's three other writes
 * (toggleDone, removeLog, setPresent) kept printing `error.message` verbatim,
 * and they are reachable in exactly the same anon-fallback minute — `anon` has no
 * grants on practice_logs / practice_attendance either, so those calls fail with
 * a table-privilege ERROR rather than matching zero rows, which means they never
 * reach the wroteNothing/noRowsMessage guard below them that would have said the
 * right thing. A member ticking their own homework saw "permission denied for
 * table practice_logs".
 *
 * Ordering is the whole content of this function.
 *
 * TRANSPORT is asked first: a request that never reached a server proves nothing
 * about the session or the policy. Asking `signedIn` first got this exactly
 * backwards — offline is precisely when the session cannot be proven live
 * (getSession() returns null once the token expires and the refresh can't reach
 * Supabase), so every venue fetch failure was answered with "เซสชันหมดอายุ …
 * เข้าสู่ระบบใหม่". On the desktop that is the one instruction that makes it
 * worse: SIGNED_OUT fires clearMgmtOutbox() (desktop/src/App.tsx), throwing away
 * every queued offline management edit — and with no network they cannot log back
 * in. The desktop calls this state offlineAuthed and supports it on purpose.
 *
 * Then "did we even go out signed?", because an unsigned 42501 is a session
 * problem wearing a permission problem's clothes, and the two need opposite
 * actions from the user (log in again vs. stop trying).
 *
 * Lives here rather than in lib/write-guard.ts — where its sibling noRowsMessage
 * lives and where it would serve the rest of the app — only because that file was
 * out of scope for the change that needed it. Hoisting it is welcome; keep the
 * ordering.
 *
 * @param signedIn  hasLiveSession() at the moment the write failed
 */
export function writeFailureMessage(
  code: string | null | undefined,
  message: string | null | undefined,
  signedIn: boolean
): string {
  if (isTransportFailure(message)) {
    return "ทำรายการไม่สำเร็จ — อาจเป็นเพราะเน็ตหลุด ลองใหม่อีกครั้ง";
  }
  if (!signedIn) {
    return "เซสชันหมดอายุ ระบบจึงยังไม่ได้บันทึก — เข้าสู่ระบบใหม่แล้วลองอีกครั้ง";
  }
  if (isRlsRefusal(code, message)) {
    // "ห้องซ้อม", not "สมุดซ้อม": both halves of the practice room call this —
    // the player's marker / practice-song writes carry the identical write clause.
    return "บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้ในห้องซ้อมของวงนี้ — ถ้าคิดว่าไม่ถูกต้อง ลองโหลดหน้าใหม่";
  }
  // Deliberately hedged, and deliberately the same sentence as the transport arm
  // above: a 5xx, a constraint the policy did not raise, or a network failure
  // whose message we did not recognise all land here, and we cannot tell them
  // apart — so do not assert a cause.
  return "ทำรายการไม่สำเร็จ — อาจเป็นเพราะเน็ตหลุด ลองใหม่อีกครั้ง";
}
