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
    // ⚠️ 'online' + mount ALONE IS NOT ENOUGH, and the run-order queue is the
    // reason. Its flush deliberately refuses to act without a proven session,
    // and the 'online' event fires in exactly the minute supabase-js is still
    // sending the anon key — so the one attempt a reconnect gets is the one most
    // likely to do nothing. Nothing re-armed it, so the queue could sit full for
    // the rest of a festival while the network was fine, and the board it
    // belongs to kept every later press local (a press on a queued row must be
    // queued too, or its precondition would be against state the server has
    // never seen). Re-arm on returning to the foreground and on a slow timer, so
    // a queue that failed to drain always gets another turn.
    const onVisible = () => {
      if (document.visibilityState === "visible") flush();
    };
    const timer = setInterval(flush, 30_000);
    window.addEventListener("online", flush);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", flush);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
