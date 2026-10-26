"use client";

import { useEffect, useRef } from "react";
import {
  acknowledgeUnsavedWork,
  commitFocusedField,
  hasUnsavedWork,
  setUnsavedDraft,
  subscribeUnsavedWork,
  unsavedWork,
  unsavedWorkMessageFor,
} from "@/lib/dirty-guard";
import { isLiveShowActive } from "@/lib/live-guard";

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

    // …and tell it EAGERLY, the moment there is something to lose, not from inside
    // beforeunload. main.cjs updateBusyReason() decides whether the update box may
    // offer "ติดตั้งเลย" from what it has been told; told only at close time, it saw
    // "not busy" over a failed or in-flight save, and on Windows quitAndInstall
    // spawns the installer BEFORE the quit this guard then vetoes — the installer
    // kills the app ~1 s later anyway, edit and all.
    //
    // main keeps ONE reason slot, shared with Live Mode / Quick Show ("show"). So:
    //   • "unsaved" is never sent while a live show is running here — a show
    //     outranks it, and main's box for a show is the right one;
    //   • null is only ever sent to take back OUR "unsaved" — never blindly, so
    //     this guard cannot wipe a "show" someone else set.
    // On mount it asserts the current state: Live Mode's own teardown sends null,
    // and a sticky failure from before it ran is still a failure.
    let reported = false;
    const report = (unsaved: boolean, again = false) => {
      if (!native) return;
      if (unsaved && isLiveShowActive()) return;
      if (unsaved === reported && !again) return;
      reported = unsaved;
      native.setUnloadReason(unsaved ? "unsaved" : null).catch(() => {});
    };
    report(hasUnsavedWork());
    const unsubscribe = subscribeUnsavedWork(() => report(hasUnsavedWork()));

    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || !isGuardedNavigation(e, a)) return;

      // SNAPSHOT FIRST, then commit. Blurring the focused field starts a write, and
      // this guard is the thing doing the blurring — judged on the live counters it
      // would ask about its own save on every single navigation. Only work that was
      // already outstanding counts. See unsavedWorkMessageFor.
      const before = unsavedWork();
      commitFocusedField();
      const message = unsavedWorkMessageFor(before);
      if (!message) return;

      if (window.confirm(message)) {
        acknowledgeUnsavedWork();
        // Deliberately NOT preventDefault + window.location.href: that is a full
        // document load, which cancels every request in flight — including the
        // save we just started by blurring. Letting the click through keeps the
        // app's own client-side navigation, and the write survives it.
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      commitFocusedField();
      // NOT the click path's snapshot rule, on purpose: a real unload kills every
      // request on the wire, so the save the blur above just started WOULD be lost.
      // Here the live counters are the honest ones.
      if (!hasUnsavedWork()) return;
      // Said again even if already said: main forgets the reason whenever a
      // document navigation STARTS (did-start-navigation), and one that started and
      // went nowhere leaves this document alive with main none the wiser.
      report(true, true);
      e.preventDefault();
      e.returnValue = "";
    };

    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      unsubscribe();
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
      report(false);
    };
  }, [enabled]);
}

/**
 * The same guard for a form that does NOT autosave (EventForm): nothing reaches the
 * server until บันทึก, so typed changes are the unsaved work. `dirty` = what is on
 * screen differs from what the form opened with (or last saved).
 *
 * The draft is filed in lib/dirty-guard.ts rather than kept here, so every exit
 * that already asks that module — this hook's link and tab-close guards, the
 * sign-out button, the notification bell, the desktop's update installer — asks
 * about it too, in the same words.
 */
export function useUnsavedDraftGuard(dirty: boolean): void {
  const owner = useRef<object>({});
  useEffect(() => {
    setUnsavedDraft(owner.current, dirty);
  }, [dirty]);
  // A form that is gone has nothing left to lose; the navigation that unmounted it
  // is the one the user was asked about.
  useEffect(() => {
    const me = owner.current;
    return () => setUnsavedDraft(me, false);
  }, []);
  useLeaveGuard(true);
}
