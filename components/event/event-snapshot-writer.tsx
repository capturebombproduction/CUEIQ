"use client";

import { useEffect } from "react";
import { saveEventSnapshot, type EventSnapshot } from "@/lib/event-store";

/**
 * Invisible: on every live-page load it persists the show's data (meta + setlist +
 * song→audio map + edit permission) into IndexedDB, so this device can cold-boot
 * the show OFFLINE later via the shell (app/live-shell) even if the page itself was
 * never cached by the service worker. Pure side-effect — it renders nothing and
 * never touches Live Mode's behaviour. See docs/offline-first-plan.md P1.
 */
export function EventSnapshotWriter(snap: Omit<EventSnapshot, "savedAt">) {
  useEffect(() => {
    // The props are fixed for this page load, so one write per load captures the
    // freshest server data. Best-effort: failure only loses offline cold-boot, the
    // online show is unaffected.
    saveEventSnapshot(snap).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.eventId]);
  return null;
}
