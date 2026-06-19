"use client";

import { useEffect } from "react";

/**
 * Registers the offline service worker (public/sw.js).
 *
 * Production-only on purpose: in `next dev` the chunks under /_next/static change
 * on every edit, and a cache-first worker would serve stale ones and break HMR.
 * The shipped (built) app is where offline matters anyway.
 */
export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  // Ask the browser NOT to evict our storage (IndexedDB audio cache + the SW app
  // shell) to free space — otherwise a low-storage phone could quietly drop a
  // downloaded track mid-show. Best-effort, runs in dev too; only requests if
  // not already persisted (some browsers auto-grant by engagement).
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
