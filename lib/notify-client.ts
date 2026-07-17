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
  | "song_rejected"
  | "song_cleared"
  | "run_order_live";

// The desktop SPA has no /api routes of its own — a relative fetch resolves
// against file:// and silently dies. Same seam as lib/audio-remote's presign:
// target the web origin (CUEIQ_WEB_ORIGIN, vite-defined in the desktop bundle,
// undefined in the Next build → relative same-origin fetch, unchanged on web)
// and authorize with a Bearer token, since cross-origin requests don't carry
// the web's cookies. /api/notify accepts either, like /api/audio/presign.
async function send(
  kind: NotifyKind,
  payload: { eventId?: string; songId?: string }
): Promise<void> {
  const webOrigin = process.env.CUEIQ_WEB_ORIGIN;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (webOrigin) {
    const { data } = await createClient().auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  await fetch(`${webOrigin ?? ""}/api/notify`, {
    method: "POST",
    headers,
    body: JSON.stringify({ kind, ...payload }),
    keepalive: true,
  });
}

export function notify(
  kind: NotifyKind,
  payload: { eventId?: string; songId?: string }
): void {
  try {
    void send(kind, payload).catch(() => {});
  } catch {
    /* never block the UI */
  }
}
