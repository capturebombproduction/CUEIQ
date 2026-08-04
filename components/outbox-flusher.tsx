"use client";

import { useEffect } from "react";
import { flushOutbox } from "@/lib/show-run-outbox";
import { flushRunSeqOutbox } from "@/lib/run-order-outbox";

/**
 * App-wide drain for the show-run outbox (offline จบโชว์ writes) and the festival
 * running-order queue. Live Mode's status strip flushes on reconnect too, but only
 * while a Live page is open — without this, a run saved offline stays queued
 * on-device until the operator happens to be back on a Live page at the exact
 * moment the network returns. The running-order queue needs it even more: a
 * show-caller closes that board the moment the festival ends, and the net often
 * comes back long after.
 * Mounted once in the root layout (web) and the desktop shell: drains on boot
 * and on every reconnect, wherever the user is in the app. Renders nothing.
 */
export function OutboxFlusher() {
  useEffect(() => {
    const flush = () => {
      if (navigator.onLine === false) return;
      flushOutbox().catch(() => {});
      flushRunSeqOutbox().catch(() => {});
    };
    flush(); // boot while online: drain anything a previous offline session left queued
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, []);
  return null;
}
