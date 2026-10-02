"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Maximize, Minimize } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isImmersivePath } from "@/components/chrome-gate";

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    window.matchMedia?.("(display-mode: fullscreen)").matches === true ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function fsSupported(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.documentElement.requestFullscreen === "function"
  );
}

/**
 * Fullscreen toggle + a "kiosk" nudge. The nudge is mounted on EVERY page (by the
 * account panel, which replaced the header tools); the toggle is the panel's switch.
 *
 * When CueIQ is launched as an INSTALLED app (standalone display mode) on a browser
 * that supports the Fullscreen API (Android Chrome / desktop), we want it to behave
 * like a native app: chrome-free and locked to fullscreen. The Fullscreen API needs
 * a user gesture, so we can't force it on load — instead we pop a gentle, persuasive
 * dialog asking the user to tap into fullscreen, and re-show it whenever they leave
 * fullscreen. Exiting is always allowed.
 *
 * iOS standalone PWAs are already chrome-free and expose no Fullscreen API, so the
 * nudge never fires there. In a normal browser tab the button is just a plain manual
 * fullscreen toggle (no nudge).
 *
 * The nudge never appears over the two screens that run a show (Live Mode and the
 * festival's live show-caller): the header, tab bar and push nudge already step aside
 * there, and a modal scrim would swallow the next NEXT/START tap while its focus trap
 * would eat the Space/N shortcuts. It is held back there, not merely hidden: it is not
 * raised while immersive, so leaving the show does not pop it up the moment the set ends.
 */
/**
 * Fullscreen state for a control that lives somewhere other than here (the account
 * panel's Fullscreen switch). `available` follows the same rule as KioskMode's own
 * button: never inside an installed app (already chrome-free) and never where the
 * Fullscreen API is missing (every iPhone), so a switch that cannot work is not shown.
 */
export function useFullscreen(): { fs: boolean; available: boolean; toggle: () => void } {
  const [fs, setFs] = useState(false);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    setAvailable(!isStandalone() && fsSupported());
    const onChange = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    onChange();
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);
  return { fs, available, toggle };
}

/** `button={false}`: only the installed-app nudge. The account panel mounts it that
 *  way, always (the panel's own contents unmount when it closes, and the nudge has
 *  to be able to appear on any page); its Fullscreen switch uses useFullscreen. */
export function KioskMode({ button = true }: { button?: boolean } = {}) {
  const [fs, setFs] = useState(false);
  const [nudge, setNudge] = useState(false);
  // On Live / the live show-caller the nudge stays down (see the note above). A ref as
  // well as a value: the fullscreenchange listener below is bound once, on mount.
  const immersive = isImmersivePath(usePathname());
  const immersiveRef = useRef(immersive);
  useEffect(() => {
    immersiveRef.current = immersive;
  }, [immersive]);
  // Already running as an installed app → it's chrome-free, so the manual
  // fullscreen toggle is redundant (and a no-op on iOS, which has no
  // Fullscreen API). Hide the button there; only show it in a browser tab.
  const [standalone, setStandalone] = useState(false);
  // …and on iPhone there is no Fullscreen API at all, so the button was a control
  // that visibly did nothing on every page (enter() optional-chains straight into
  // undefined and swallows it). Render it only where it can work.
  const [supported, setSupported] = useState(false);
  const kioskRef = useRef(false); // installed app + Fullscreen API available
  const wasFsRef = useRef(false);

  const enter = useCallback(() => {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      enter();
    }
  }, [enter]);

  useEffect(() => {
    setStandalone(isStandalone());
    setSupported(fsSupported());
    const kiosk = isStandalone() && fsSupported();
    kioskRef.current = kiosk;

    const onChange = () => {
      const isFs = !!document.fullscreenElement;
      setFs(isFs);
      if (kioskRef.current) {
        // Re-nudge whenever the user actively LEAVES fullscreen; hide it once in.
        if (!isFs && wasFsRef.current && !immersiveRef.current) setNudge(true);
        if (isFs) setNudge(false);
      }
      wasFsRef.current = isFs;
    };

    document.addEventListener("fullscreenchange", onChange);
    onChange();

    // Installed app opened outside fullscreen → nudge the user to lock it in.
    if (kiosk && !document.fullscreenElement && !immersiveRef.current) setNudge(true);

    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  return (
    <>
      {button && !standalone && supported && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={toggle}
          title={fs ? "ออกจากโหมดเต็มจอ" : "โหมดเต็มจอ"}
          aria-label={fs ? "ออกจากโหมดเต็มจอ" : "เข้าสู่โหมดเต็มจอ"}
        >
          {fs ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
        </Button>
      )}

      <Dialog open={nudge && !immersive} onOpenChange={setNudge}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Best Performance</DialogTitle>
            <DialogDescription>
              โปรดใช้งาน CueIQ ในโหมดเต็มจอ เพื่อประสบการณ์ที่ลื่นไหลและเต็มประสิทธิภาพที่สุด
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNudge(false)}>
              ไว้ภายหลัง
            </Button>
            <Button
              onClick={() => {
                enter();
                setNudge(false);
              }}
            >
              <Maximize className="h-4 w-4" /> เข้าสู่โหมดเต็มจอ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
