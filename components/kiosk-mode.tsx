"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * Fullscreen toggle (lives in the header, so it's on EVERY page) + a "kiosk" nudge.
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
 */
export function KioskMode() {
  const [fs, setFs] = useState(false);
  const [nudge, setNudge] = useState(false);
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
    const kiosk = isStandalone() && fsSupported();
    kioskRef.current = kiosk;

    const onChange = () => {
      const isFs = !!document.fullscreenElement;
      setFs(isFs);
      if (kioskRef.current) {
        // Re-nudge whenever the user actively LEAVES fullscreen; hide it once in.
        if (!isFs && wasFsRef.current) setNudge(true);
        if (isFs) setNudge(false);
      }
      wasFsRef.current = isFs;
    };

    document.addEventListener("fullscreenchange", onChange);
    onChange();

    // Installed app opened outside fullscreen → nudge the user to lock it in.
    if (kiosk && !document.fullscreenElement) setNudge(true);

    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  return (
    <>
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

      <Dialog open={nudge} onOpenChange={setNudge}>
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
