"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { WifiOff } from "lucide-react";

// How many header-hosted strips are mounted right now. While the app header hosts
// one, the root layout's copy stands down, so an (app) page never shows two.
let hosted = 0;
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const hostedNow = () => hosted;
const noneOnServer = () => 0;

// The header-hosted strip is IN FLOW inside a sticky header, so offline the header
// is taller by the strip — and a bar stuck under that header (the Event page's tab
// row, top = var(--header-h)) has to clear it too, or the strip's height of it
// slides under the glass. Each header-hosted strip on screen reports its measured
// height (it wraps to two lines on a 360px phone); the tallest is published as
// --offline-strip-h on the root, and the property is removed when none is left.
const stripHeights = new Map<object, number>();
function publishStripHeight(key: object, height: number | null) {
  if (height === null) stripHeights.delete(key);
  else stripHeights.set(key, height);
  const root = document.documentElement.style;
  if (stripHeights.size === 0) root.removeProperty("--offline-strip-h");
  else root.setProperty("--offline-strip-h", `${Math.max(...stripHeights.values())}px`);
}

function useOffline(): boolean {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return offline;
}

/**
 * Thin strip shown whenever the device goes offline, so an operator mid-show
 * knows the app is now running on cached data + on-device audio (not live).
 * Live Mode keeps its own realtime "การเชื่อมต่อหลุด" banner for sync state — this
 * one is the app-wide network indicator.
 *
 * It is IN FLOW, never fixed. It used to be a fixed bar over the top 28px of the
 * screen — on top of the sticky header, i.e. over the back link, the bell and the
 * install button, exactly when someone at a venue needed them. Now:
 *  • placement="header": the app header's own second row (SiteHeader, the desktop
 *    shell), so it pushes the page down and sticks with the header;
 *  • placement="flow" (default, root layout): the same strip at the top of the
 *    page, for screens without that header (login, share links, immersive Live).
 *    It stands down while a header-hosted one is mounted.
 */
export function OfflineBanner({ placement = "flow" }: { placement?: "flow" | "header" }) {
  const offline = useOffline();
  const hostedByHeader = useSyncExternalStore(subscribe, hostedNow, noneOnServer);

  useEffect(() => {
    if (placement !== "header") return;
    hosted += 1;
    listeners.forEach((l) => l());
    return () => {
      hosted -= 1;
      listeners.forEach((l) => l());
    };
  }, [placement]);

  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stripRef.current;
    if (placement !== "header" || !offline || !el) return;
    const key = {};
    const measure = () => publishStripHeight(key, el.getBoundingClientRect().height);
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      publishStripHeight(key, null);
    };
  }, [placement, offline]);

  if (!offline || (placement === "flow" && hostedByHeader > 0)) return null;
  return (
    <div
      ref={stripRef}
      role="status"
      data-testid="offline-strip"
      // min-h, not h-7: on a 360px phone the Thai sentence wraps, and a fixed
      // height would clip its second line.
      className="no-print flex min-h-7 items-center justify-center gap-2 bg-warning/15 px-3 py-1 text-center text-[12.5px] font-medium leading-snug text-warning-ink shadow-[inset_0_1px_0_hsl(var(--warning)/.4)]"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
      ออฟไลน์ — กำลังใช้ข้อมูลและไฟล์เพลงที่บันทึกไว้ในเครื่อง
    </div>
  );
}
