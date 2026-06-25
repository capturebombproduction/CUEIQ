"use client";

import { useEffect } from "react";
import { saveEventSnapshot, type EventSnapshot } from "@/lib/event-store";

/**
 * Invisible: on every live-page load it persists the show's data (meta + setlist +
 * song→audio map + edit permission) into IndexedDB, so the device can run the show
 * OFFLINE later from local data. The web app no longer cold-boots offline (that path
 * moved to the CueIQ Desktop app) — this component now ships only in the desktop
 * renderer, where its live page reads the snapshot back. Pure side-effect: renders
 * nothing and never touches Live Mode's behaviour.
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
