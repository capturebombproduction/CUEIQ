"use client";

import { useEffect, useState } from "react";
import { Download, Share, SquarePlus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

const BTN_CLASS =
  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground";

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  const ua = navigator.userAgent;
  // iPhone/iPod/older iPad, plus iPadOS 13+ which reports as "MacIntel" but has touch.
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/**
 * "Install app" — offered on EVERY device, not just Chromium:
 *  • Chrome / Edge / Android fire `beforeinstallprompt` → one-tap install.
 *  • iOS (Safari/iPad) has no such event — Apple only allows manual install — so
 *    we show the Share → "Add to Home Screen" steps instead. The app's
 *    apple-mobile-web-app meta + manifest already make it launch standalone once
 *    added.
 * Hidden when already installed (standalone display mode).
 */
export function InstallButton() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    if (isStandalone()) return; // already installed → nothing to offer
    if (isIOS()) {
      setIos(true); // iOS → manual instructions (no beforeinstallprompt on Apple)
      return;
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPromptEvent);
    };
    const onInstalled = () => setPrompt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    const p = prompt;
    setPrompt(null);
    try {
      await p?.prompt();
    } catch {
      /* user dismissed */
    }
  }

  // iOS: a button that explains the manual steps (Apple gives no install API).
  if (ios) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowHelp(true)}
          title="ติดตั้ง CueIQ ลงเครื่อง — เปิดเร็วขึ้นและใช้ออฟไลน์ได้"
          className={BTN_CLASS}
        >
          <Download className="h-4 w-4" />
          <span className="hidden sm:inline">ติดตั้งแอป</span>
        </button>
        <Dialog open={showHelp} onOpenChange={setShowHelp}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>ติดตั้ง CueIQ ลงไอโฟน / ไอแพด</DialogTitle>
              <DialogDescription>
                บน iOS ติดตั้งผ่าน Safari เองไม่กี่ขั้นตอน — ติดแล้วเปิดจากหน้าจอโฮมได้เหมือนแอป
                และใช้งานออฟไลน์ได้
              </DialogDescription>
            </DialogHeader>
            <ol className="space-y-3 text-sm">
              <li className="flex items-start gap-3">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                  1
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  เปิดหน้านี้ใน <b>Safari</b> แล้วแตะปุ่มแชร์
                  <Share className="inline h-4 w-4" /> (อยู่แถบล่างของจอ)
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                  2
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  เลื่อนลงแล้วเลือก <b>“เพิ่มลงในหน้าจอโฮม”</b>
                  <SquarePlus className="inline h-4 w-4" /> (Add to Home Screen)
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                  3
                </span>
                <span>
                  แตะ <b>“เพิ่ม”</b> มุมขวาบน — เสร็จแล้วไอคอน CueIQ จะอยู่บนหน้าจอโฮม
                </span>
              </li>
            </ol>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // Chromium (Android/desktop): one-tap install when the browser offers it.
  if (!prompt) return null;
  return (
    <button
      type="button"
      onClick={install}
      title="ติดตั้ง CueIQ ลงเครื่อง — เปิดเร็วขึ้นและใช้ออฟไลน์ได้"
      className={BTN_CLASS}
    >
      <Download className="h-4 w-4" />
      <span className="hidden sm:inline">ติดตั้งแอป</span>
    </button>
  );
}
