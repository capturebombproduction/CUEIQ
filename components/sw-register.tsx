"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

// A running show must never blink: don't reload to a new build while a live set or
// practice session is on screen. A parked update applies on the next safe page
// (route change / foreground) instead — see applyIfSafe.
const SHOW_PATHS = /\/events\/[^/]+\/(live|practice)/;

/**
 * Registers the offline service worker (public/sw.js).
 *
 * Production-only on purpose: in `next dev` the chunks under /_next/static change
 * on every edit, and a cache-first worker would serve stale ones and break HMR.
 * The shipped (built) app is where offline matters anyway.
 *
 * Also drives show-safe auto-update: an installed kiosk PWA rarely closes every
 * tab, so a new worker would otherwise sit "waiting" forever and the app stays on a
 * stale build. Here we poll for updates and tell a waiting worker to take over at
 * once — but only off the live/practice pages — then reload onto the fresh chunks.
 */
export function SwRegister() {
  const pathname = usePathname();
  const regRef = useRef<ServiceWorkerRegistration | null>(null);
  const askedToSkip = useRef(false);
  const reloading = useRef(false);

  // Hand control to a waiting worker — but never mid-show. Reads live values
  // (refs + current path) so it's safe to call from any handler or effect.
  const applyIfSafe = () => {
    const reg = regRef.current;
    if (!reg?.waiting) return;
    if (SHOW_PATHS.test(window.location.pathname)) return;
    askedToSkip.current = true;
    reg.waiting.postMessage({ type: "SKIP_WAITING" });
  };

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    // When the worker we asked to skip takes control, refresh onto the fresh build —
    // but NEVER under the user's hands. A band could be mid-form (event create/edit
    // is a batch save), so we wait until the page is hidden (tab backgrounded / app
    // switched away) to reload; until then the now-active worker already serves the
    // fresh build on the next navigation. Guarded so a first-ever install (which
    // also fires controllerchange) and reload loops can't bounce the page.
    const reloadWhenHidden = () => {
      if (document.visibilityState !== "hidden" || reloading.current) return;
      reloading.current = true;
      window.location.reload();
    };
    const onControllerChange = () => {
      if (!askedToSkip.current || reloading.current) return;
      if (document.visibilityState === "hidden") reloadWhenHidden();
      else document.addEventListener("visibilitychange", reloadWhenHidden);
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          regRef.current = reg;
          applyIfSafe(); // a previous load may have already parked an update
          reg.addEventListener("updatefound", () => {
            const sw = reg.installing;
            if (!sw) return;
            sw.addEventListener("statechange", () => {
              // installed + an existing controller ⇒ an update, not a first
              // install ⇒ swap it in when safe.
              if (sw.state === "installed" && navigator.serviceWorker.controller) {
                applyIfSafe();
              }
            });
          });
        })
        .catch(() => {});
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    // A kiosk PWA rarely reloads itself — poll for a new build whenever it returns
    // to the foreground, and apply any parked update then.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      regRef.current?.update().catch(() => {});
      applyIfSafe();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("visibilitychange", reloadWhenHidden);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving a live/practice page is the moment a parked update becomes safe to apply.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    applyIfSafe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

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
