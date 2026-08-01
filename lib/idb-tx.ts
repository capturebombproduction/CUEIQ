// One-line guard against the IndexedDB failure mode that HANGS instead of failing.
//
// A promise around an IndexedDB transaction normally settles on the request's
// 'success' / 'error'. That covers most failures, because a request error bubbles
// up to the transaction. It does NOT cover a failed COMMIT: when the transaction
// itself can't be written (quota is the one that actually happens on a show
// machine — 27–88 MB masters, a cached run sheet and the offline queue all share
// this origin's budget), the browser fires 'abort' ALONE and no request error ever
// arrives. A promise that only listens for success/error then never settles at all.
//
// That is worse than an error everywhere it happens: `await cacheSongBlob(...)`
// stalls "เตรียมเพลง" forever with no failure to report, and an await inside the
// management outbox's lock wedges every later offline save behind it for the rest
// of the session. Every caller in this codebase already handles a rejection.
//
// Usage: register it alongside the other handlers, settling the same way they do.
//   tx.oncomplete = () => { db.close(); resolve(); };
//   tx.onerror = () => { db.close(); reject(tx.error); };
//   settleOnAbort(tx, () => { db.close(); reject(tx.error); });
// Settling twice is harmless — a settled promise ignores it, and db.close() is
// idempotent — so it is always safe to add.
export function settleOnAbort(tx: IDBTransaction, settle: () => void): void {
  tx.onabort = settle;
}
