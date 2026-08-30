// ---------------------------------------------------------------------------
// "ยังไม่ได้บันทึก" — the one place that knows whether leaving would lose work.
//
// WHY THIS EXISTS. Asked for by name through the in-app channel on 2026-08-13:
// "เวลาที่มีการแก้ไข แล้วจะเปลี่ยนหน้าไปหน้าอื่น อยากให้มีการเตือนว่า ยังไม่ได้บันทึก".
// Round 13 answered the first half of that person's message (the บันทึกแล้ว badge)
// and missed this half.
//
// WHAT "UNSAVED" MEANS HERE, AND WHAT IT DOES NOT. Every editor in the event
// workspace autosaves on blur — there is no form and no submit — so the honest
// definition is narrow:
//
//   • a write is IN FLIGHT  → leaving now can abort it;
//   • a write FAILED        → the row on screen is not the row on the server.
//
// and NOT:
//
//   • a write that was QUEUED OFFLINE. That is on disk, it will flush, and both
//     tracked editors already report it as บันทึกแล้ว. Warning about it would fire
//     on every edit made at a venue — the place this app is actually used.
//   • text sitting in a focused field. The guard COMMITS that instead of asking
//     about it (blur → the editor's own onBlur → persist), so the ordinary "I
//     typed and clicked the logo" turns into a save, not a dialog.
//
// A MODULE-LEVEL flag, not React state, for two reasons. EventWorkspace re-keys a
// hidden tab's editor whenever server props change, which remounts it and would
// silently reset any component-held flag; and the two exits that are NOT anchors
// (the sign-out button's router.replace, the notification bell's router.push) live
// in other component trees entirely — Next's app router exposes no navigation
// guard, so those call sites have to ask by hand. lib/live-guard.ts is the same
// shape for the same reason and this is its twin.
// ---------------------------------------------------------------------------

/** Writes started and not yet settled. */
let pending = 0;
/** A write that reported failure since the last acknowledgement. Sticky: a LATER
 *  write succeeding says nothing about the row that failed, so success does not
 *  clear it — only telling the user does (acknowledgeUnsavedWork), or a reload. */
let failed = 0;

/** A write is starting. Pair with settled() exactly once, on every path. */
export function markPending(): void {
  pending += 1;
}

/** A write finished. `ok:false` for a real failure only — never for an offline
 *  queue, which is saved (see the header). */
export function markSettled(ok: boolean): void {
  pending = Math.max(0, pending - 1);
  if (!ok) failed += 1;
}

/**
 * The editor that started these writes is gone (a tab re-key, or a navigation the
 * guard already warned about and the user accepted). In an SPA the fetch itself
 * usually keeps going, so we no longer know how it ends: stop counting it, but do
 * NOT record a failure — the user was asked at the moment they left, and asking
 * again on the next page about a write nobody is waiting for is noise.
 */
export function markAbandoned(n: number): void {
  pending = Math.max(0, pending - Math.max(0, n));
}

export interface UnsavedWork {
  /** writes still in flight */
  pending: number;
  /** writes that reported failure and have not been acknowledged */
  failed: number;
}

export function unsavedWork(): UnsavedWork {
  return { pending, failed };
}

/** True when leaving right now could lose something. */
export function hasUnsavedWork(): boolean {
  return pending > 0 || failed > 0;
}

/**
 * The Thai sentence to put in front of the user, or null when there is nothing to
 * say. Separated from the guard itself so every exit — the anchor guard, the
 * sign-out button, the bell — asks the same question in the same words.
 */
export function unsavedWorkMessage(exit: "page" | "signout" = "page"): string | null {
  return unsavedWorkMessageFor(unsavedWork(), exit);
}

/**
 * The same sentence, but about a SNAPSHOT rather than about right now.
 *
 * ⚠️ THIS IS THE WHOLE REASON THE GUARD IS USABLE. Every editor here persists on
 * BLUR, unconditionally — `onBlur={(e) => persist(it.id, { title: e.target.value })}`
 * runs even when nothing was typed. And a click on a link blurs the focused field
 * first (Chromium focuses the anchor on mousedown), so by the time the guard's own
 * commitFocusedField() returns, `pending` is 1 because of the guard itself.
 *
 * Judged on the live counters, the dialog therefore appeared on EVERY navigation
 * after so much as tapping into a field — over a save that lands 200 ms later and
 * is not lost at all. A warning that fires when nothing is wrong is worse than no
 * warning: the next one, the real one, gets dismissed on reflex.
 *
 * So each exit snapshots FIRST and asks about the snapshot. A write the exit
 * gesture itself started is the save the user asked for, not work they are losing.
 */
export function unsavedWorkMessageFor(
  work: UnsavedWork,
  exit: "page" | "signout" = "page"
): string | null {
  const leaving = exit === "signout" ? "ออกจากระบบตอนนี้" : "ออกจากหน้านี้ตอนนี้";
  if (work.failed > 0) {
    return `มีการแก้ไขที่ยังบันทึกไม่สำเร็จ — ${leaving}จะหายไป ออกเลยไหม?`;
  }
  if (work.pending > 0) {
    return `กำลังบันทึกอยู่ — ${leaving}อาจบันทึกไม่ครบ ออกเลยไหม?`;
  }
  return null;
}

/** The user has been shown the warning and chose to go anyway. Clears the sticky
 *  failure so they are not asked about the same lost edit at every later exit. */
export function acknowledgeUnsavedWork(): void {
  failed = 0;
}

/** Tests only — and the one call that must never appear in app code, because a
 *  reset that isn't an acknowledgement is how a real failure gets forgotten. */
export function resetDirtyGuard(): void {
  pending = 0;
  failed = 0;
}

/**
 * Give any INPUT/TEXTAREA that still has focus its normal blur→persist path before
 * anything reads the flags. Exported (rather than inlined in the workspace) so the
 * out-of-tree exits can commit first too: a half-typed stage time should be saved
 * by pressing sign-out, not lost by it.
 *
 * Returns true if it blurred something, so a caller can let the write it just
 * started reach markPending() before evaluating.
 */
export function commitFocusedField(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return false;
  el.blur();
  return true;
}
