"use client";

import { useEffect } from "react";
import { flushOutbox } from "@/lib/show-run-outbox";

/**
 * Drains the show-run outbox (writes that failed while offline) whenever the app
 * is open and connected — on mount, when the network returns, and when the tab is
 * refocused. Invisible and app-wide so a show run fully offline syncs its result
 * to the server as soon as the device is back online, no matter which page is open.
 * See lib/show-run-outbox.ts + docs/offline-first-plan.md P2.
 */
export function OutboxFlusher() {
  useEffect(() => {
    const run = () => {
      if (navigator.onLine !== false) flushOutbox().catch(() => {});
    };
    run();
    const onVisible = () => document.visibilityState === "visible" && run();
    window.addEventListener("online", run);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", run);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
