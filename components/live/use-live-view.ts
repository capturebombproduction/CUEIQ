"use client";

// Which board this device shows in Live Mode - STAGE (the approved screen, and the default) or
// CONSOLE (components/live/console-board.tsx) - and whether this screen may show CONSOLE at all.
// The choice is per device (the PA laptop on CONSOLE, a tablet beside it on STAGE), kept like the
// sound and output choices. A screen below the stage size (a phone, a portrait tablet, a short
// window) always gets STAGE whatever was chosen: CONSOLE has no small layout.
//
// Both start as STAGE / false and are read after mount, so the server's render and the first
// client render agree; the board swaps in one frame later, before anyone can press anything.
import { useCallback, useEffect, useState } from "react";
import { LIVE_VIEW_KEY, readLiveView, STAGE_MEDIA, type LiveView } from "@/lib/console-view";

export function useLiveView(): { view: LiveView; setView: (v: LiveView) => void; stageScreen: boolean } {
  const [view, setViewState] = useState<LiveView>("stage");
  const [stageScreen, setStageScreen] = useState(false);
  useEffect(() => {
    try {
      setViewState(readLiveView(localStorage.getItem(LIVE_VIEW_KEY)));
    } catch {
      /* no storage: STAGE */
    }
    const mq = typeof window !== "undefined" ? window.matchMedia?.(STAGE_MEDIA) : undefined;
    if (!mq) return;
    const update = () => setStageScreen(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  const setView = useCallback((v: LiveView) => {
    setViewState(v);
    try {
      localStorage.setItem(LIVE_VIEW_KEY, v);
    } catch {
      /* not kept: this page still shows it */
    }
  }, []);
  return { view, setView, stageScreen };
}
