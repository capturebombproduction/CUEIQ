// Fire-and-forget client helper: ping /api/notify after a status/copyright change.
// Never blocks or throws into the UI — a failed notification must not break the
// action that triggered it. The server re-verifies the real state + decides
// recipients, so this only needs the kind + the subject id.

import { createClient } from "@/lib/supabase/client";

export type NotifyKind =
  | "event_submitted"
  | "event_approved"
  | "event_rejected"
  | "song_pending"
  | "song_resubmitted"
  | "song_rejected"
  | "song_cleared"
  | "run_order_live"
  | "feedback_replied";

/** The subject the server should look up. Exactly one of these is used per kind;
 *  the server never takes a recipient from the client. */
export interface NotifyPayload {
  eventId?: string;
  songId?: string;
  feedbackId?: string;
}

// The desktop SPA has no /api routes of its own — a relative fetch resolves
// against file:// and silently dies. Same seam as lib/audio-remote's presign:
// target the web origin (CUEIQ_WEB_ORIGIN, vite-defined in the desktop bundle,
// undefined in the Next build → relative same-origin fetch, unchanged on web)
// and authorize with a Bearer token, since cross-origin requests don't carry
// the web's cookies. /api/notify accepts either, like /api/audio/presign.
/** What /api/notify answered, for the one caller that shows it (the คุมคิว board):
 *  `skipped: "not_show_time"` = "งานเริ่มแล้ว" was held back - not the show's real date
 *  and time (app/api/notify step 3d). */
export interface NotifyAnswer {
  ok?: boolean;
  sent?: number;
  skipped?: string;
}

async function send(
  kind: NotifyKind,
  payload: NotifyPayload
): Promise<NotifyAnswer | null> {
  const webOrigin = process.env.CUEIQ_WEB_ORIGIN;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (webOrigin) {
    const { data } = await createClient().auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${webOrigin ?? ""}/api/notify`, {
    method: "POST",
    headers,
    body: JSON.stringify({ kind, ...payload }),
    keepalive: true,
  });
  return typeof res?.json === "function" ? ((await res.json().catch(() => null)) as NotifyAnswer | null) : null;
}

export function notify(
  kind: NotifyKind,
  payload: NotifyPayload,
  onAnswer?: (answer: NotifyAnswer) => void
): void {
  try {
    void send(kind, payload)
      .then((answer) => {
        if (answer && onAnswer) onAnswer(answer);
      })
      .catch(() => {});
  } catch {
    /* never block the UI */
  }
}
