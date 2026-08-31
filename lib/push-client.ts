"use client";

// ---------------------------------------------------------------------------
// The two primitives every Web Push caller needs, in one place so that a second
// caller (the nudge) cannot drift from the first (the bell).
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE try/catch IS NOT DEFENSIVE PADDING — IT IS THE REASON THIS IS A FUNCTION.
 *
 * `process.env.NEXT_PUBLIC_*` is substituted at build time (Next inlines it; the
 * desktop does it through vite `define`). A build that misses the substitution
 * leaves a bare `process`, which does not exist in the Electron renderer
 * (contextIsolation on, node integration off) — so reading it at module scope
 * would THROW during module evaluation and white-screen the app, instead of
 * simply leaving push "unsupported", which is the correct outcome there.
 */
export function vapidPublicKey(): string | undefined {
  try {
    return process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  } catch {
    return undefined;
  }
}

/** The VAPID public key as the bytes `pushManager.subscribe` wants. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
