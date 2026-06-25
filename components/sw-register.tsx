"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (public/sw.js).
 *
 * The worker is now Web Push ONLY — the offline-run path moved to the CueIQ
 * Desktop app, so there is no offline cache, no fetch interception, and no
 * show-safe auto-update dance here anymore. We just need a registration so the
 * notification bell can subscribe via `navigator.serviceWorker.ready`.
 *
 * Production-only: a worker isn't useful in `next dev` (and we don't want one
 * lingering during development).
 */
export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  // Ask the browser NOT to evict our storage (the on-device audio cache: songs
  // prepared for a show or cached on first play) so a low-storage device can't
  // quietly drop a downloaded track. Best-effort; only requests if not already
  // persisted (some browsers auto-grant by engagement).
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return;
    navigator.storage
      .persisted()
      .then((already) => {
        if (!already) navigator.storage.persist().catch(() => {});
      })
      .catch(() => {});
  }, []);

  return null;
}
