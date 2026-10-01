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

// A 44px icon in the one-row header, beside the bell (FINAL-SPEC-v2 §F.1). The
// word stays for screen readers and in the title tooltip.
const BTN_CLASS =
  "relative grid h-11 w-11 shrink-0 place-items-center rounded-[3px] text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// The deferred prompt lives at MODULE scope, not in the button's state. Chrome fires
// `beforeinstallprompt` once per document load and never again on a same-document
// navigation — and since the redesign the header (and this button in it) UNMOUNTS on
// Live Mode and the show-caller (ChromeGate). Kept in state, the captured event died
// with the header: back from Live, the install icon was gone until a full reload. Kept
// here, every mount reads it. The listener is installed when this module loads, which
// ChromeGate makes sure of on every (app) page — the immersive ones included, so a
// document that OPENS on Live still catches the event.
let deferred: InstallPromptEvent | null = null;
const subscribers = new Set<() => void>();
const emit = () => subscribers.forEach((fn) => fn());
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
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
    // The module-level capture above holds the event; this mount only follows it.
    const sync = () => setPrompt(deferred);
    sync();
    subscribers.add(sync);
    return () => {
      subscribers.delete(sync);
    };
  }, []);

  async function install() {
    const p = deferred ?? prompt;
    // A prompt event can be used once: every mounted copy lets go of it.
    deferred = null;
    emit();
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
          title="ติดตั้ง CueIQ ลงเครื่อง — เปิดเร็วขึ้น ใช้งานเหมือนแอป (ยังต้องต่อเน็ต)"
          className={BTN_CLASS}
        >
          <Download className="h-[21px] w-[21px]" aria-hidden />
          <span className="sr-only">ติดตั้งแอป</span>
        </button>
        <Dialog open={showHelp} onOpenChange={setShowHelp}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>ติดตั้ง CueIQ ลงไอโฟน / ไอแพด</DialogTitle>
              <DialogDescription>
                บน iOS ติดตั้งผ่าน Safari เองไม่กี่ขั้นตอน — ติดแล้วเปิดจากหน้าจอโฮมได้เหมือนแอป
                (ยังต้องต่อเน็ตนะ ถ้าต้องรันโชว์ตอนเน็ตหลุด ให้ใช้แอป CueIQ Desktop)
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
      title="ติดตั้ง CueIQ ลงเครื่อง — เปิดเร็วขึ้น ใช้งานเหมือนแอป (ยังต้องต่อเน็ต)"
      className={BTN_CLASS}
    >
      <Download className="h-[21px] w-[21px]" aria-hidden />
      <span className="sr-only">ติดตั้งแอป</span>
    </button>
  );
}
