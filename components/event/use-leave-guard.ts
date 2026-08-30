"use client";

import { useEffect } from "react";
import {
  acknowledgeUnsavedWork,
  commitFocusedField,
  hasUnsavedWork,
  unsavedWorkMessage,
} from "@/lib/dirty-guard";

/**
 * Is this click a navigation AWAY from the current page that we could interrupt?
 *
 * Exported so the list of exemptions is testable on its own — each one is a real
 * element in this app, and a guard that swallowed any of them would read as a
 * broken button:
 *   • a modified click or a non-primary button → the browser opens a new tab;
 *   • target="_blank" → EventSummary's Google Map link;
 *   • download → not a navigation at all;
 *   • an external scheme → leaves the app entirely, nothing of ours to lose;
 *   • a bare "#…" → the workspace's own tab hash, which is not a navigation
 *     — but "#/…" IS one: that is what every desktop link looks like.
 */
export function isGuardedNavigation(
  e: Pick<MouseEvent, "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  a: HTMLAnchorElement | null
): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return false;
  }
  if (!a) return false;
  const href = a.getAttribute("href") ?? "";
  if (!href || a.hasAttribute("download")) return false;
  // A hash href is TWO different things in this app. "#summary" / "#setlist" is
  // EventWorkspace's own tab, which is not a navigation at all — but under the
  // desktop's HashRouter every in-app link renders "#/dashboard", and those ARE
  // the navigations this guard exists for. Exempting all of them would have left
  // the .exe with no anchor guard whatsoever, which is precisely how it read
  // before a test asked.
  if (href.startsWith("#") && !href.startsWith("#/")) return false;
  if (a.target && a.target !== "_self") return false;
  if (/^(https?:|mailto:|tel:)/i.test(href)) return false;
  return true;
}

/**
 * Warn before leaving the event workspace while something has not been saved.
 *
 * SHAPE COPIED FROM LIVE MODE ON PURPOSE (components/event/live-mode.tsx). Next's
 * app router exposes no navigation-guard API at all — `router.push`/`replace`/`back`
 * are structurally un-interceptable, and `<Link onNavigate>` exists only on the web
 * (the desktop's next-link shim forwards to react-router, where it is silently
 * dead). A capture-phase click listener on `a[href]` plus `beforeunload` is the one
 * shape that behaves identically in the browser and under the desktop HashRouter,
 * because it works on the raw href, which is `/path` on web and `#/path` there.
 *
 * The two exits that are NOT anchors — the sign-out button and the notification
 * bell, both of which navigate programmatically from other component trees — ask
 * lib/dirty-guard.ts by hand, exactly as they already ask lib/live-guard.ts.
 *
 * Browser Back is NOT guarded: popstate fires after the entry is already gone, and
 * the sentinel-history-entry trick would fight EventWorkspace's own replaceState
 * (which preserves history.state because react-router keeps its index there).
 * An honest gap, and the reason the workspace also commits on pagehide.
 */
export function useLeaveGuard(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    // Tell the Electron main process which of the two beforeunload guards is armed.
    // Without this its will-prevent-unload dialog says "โชว์กำลังดำเนินอยู่" — which
    // for an unsaved edit is not a warning, it is a wrong statement.
    const native = typeof window !== "undefined" ? window.cueiqNative : undefined;

    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || !isGuardedNavigation(e, a)) return;
      const href = a.getAttribute("href") ?? "";

      // Give a field that still holds focus its normal blur → persist path BEFORE
      // deciding. The common case ("I typed a stage time and clicked the logo")
      // becomes a save rather than a dialog. The write it starts is synchronous up
      // to markPending(), so hasUnsavedWork() sees it on the very next line.
      commitFocusedField();
      const message = unsavedWorkMessage();
      if (!message) return;

      e.preventDefault();
      e.stopPropagation();
      if (window.confirm(message)) {
        acknowledgeUnsavedWork();
        // The raw href works as-is on web (/path) and desktop (#/path).
        window.location.href = href;
      }
    };

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      commitFocusedField();
      if (!hasUnsavedWork()) return;
      native?.setUnloadReason("unsaved").catch(() => {});
      e.preventDefault();
      e.returnValue = "";
    };

    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
      native?.setUnloadReason(null).catch(() => {});
    };
  }, [enabled]);
}
