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
  return null;
}
