/** Resolves to `null` if `p` has not settled within `ms`.
 *
 *  THE ONE COPY of this helper. The desktop loaders (data/workspace, events-list,
 *  event-bundle, run-order, song-library) and pages (practice, event) each used to
 *  keep a local twin with a "change one, change all six" note; they import this now.
 *
 *  There is no AbortController: the in-flight request is not cancelled, it is
 *  ABANDONED. That is safe for every caller today, and this is the checklist to
 *  re-verify before assuming a late answer can corrupt anything:
 *    • the timer is cleared on BOTH outcomes (the .finally below), so a fast load
 *      leaves no handle behind;
 *    • nothing subscribes to `p` after the race settles — the caller has already
 *      been handed `null` and moved on to the cache — so a late VALUE is simply
 *      discarded. It does NOT warm any cache; no caller writes one from it. (An
 *      earlier version of this comment claimed it did, which was a benefit that never
 *      existed and, worse, the stated reason for skipping the AbortController.)
 *    • a late REJECTION is still observed by the race's own subscription, so it
 *      cannot surface as an unhandled rejection.
 *  What it does cost is a socket and its response body, held until the server or
 *  the OS gives up. Worth an AbortController the day these budgets get long or a
 *  screen fires them in a loop; not worth one today.
 *
 *  The budgets themselves stay with their callers (desktop/src/data/timeout-budgets.test.ts
 *  holds them under a ceiling). */
export function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race<T | null>([
    p,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    // Without this the pending timer keeps a handle alive for its full duration
    // after every fast, successful load.
    if (timer !== undefined) clearTimeout(timer);
  });
}
