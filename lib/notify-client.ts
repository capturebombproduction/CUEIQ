// Fire-and-forget client helper: ping /api/notify after a status/copyright change.
// Never blocks or throws into the UI — a failed notification must not break the
// action that triggered it. The server re-verifies the real state + decides
// recipients, so this only needs the kind + the subject id.

export type NotifyKind =
  | "event_submitted"
  | "event_approved"
  | "event_rejected"
  | "song_pending"
  | "song_rejected"
  | "song_cleared"
  | "run_order_live";

export function notify(
  kind: NotifyKind,
  payload: { eventId?: string; songId?: string }
): void {
  try {
    void fetch("/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, ...payload }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never block the UI */
  }
}
