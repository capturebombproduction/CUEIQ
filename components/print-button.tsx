"use client";

import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import { toast } from "sonner";
import { isIOS, isStandalone } from "@/lib/platform";

/**
 * Opens the browser print dialog (also "Save as PDF") for the current page.
 * Print styling lives in app/theme.css (@media print): light/ink-friendly, app-only
 * controls hidden via `.no-print`, rows kept from splitting across pages.
 *
 * One exception: a home-screen iOS app has no print UI at all, so window.print()
 * there does nothing and reports nothing — a button that looks fine and is simply
 * dead. Rather than hide it (a missing control reads as a bug of its own, and the
 * same person on the same page in Safari has it), say what to do instead and point
 * at the JPG export sitting next to it.
 */
export function PrintButton({
  label = "พิมพ์ / บันทึก PDF",
  /** Named alternative on THIS page, if there is one — the public share page has
   *  no JPG export, so pointing at one would send the reader hunting. */
  altHint,
}: {
  /** Text, or text that changes with the screen (a shorter one on a phone). */
  label?: React.ReactNode;
  altHint?: string;
}) {
  const [dead, setDead] = useState(false);
  useEffect(() => {
    // After mount only: both call sites are server-rendered.
    setDead(isIOS() && isStandalone());
  }, []);

  return (
    <button
      type="button"
      onClick={() =>
        dead
          ? toast.info("แอปที่ติดตั้งบน iOS สั่งพิมพ์ไม่ได้", {
              description: `เปิดหน้านี้ใน Safari เพื่อพิมพ์ / บันทึก PDF${altHint ? ` ${altHint}` : ""}`,
            })
          : window.print()
      }
      // The Button "secondary" look, written out: the public share page renders
      // this too, outside the app's Button. 44 px tall, like every control.
      className="no-print inline-flex h-11 items-center gap-2 rounded-[3px] bg-muted px-4 text-[15px] font-semibold shadow-edge transition hover:bg-muted/80"
    >
      <Printer aria-hidden className="h-[18px] w-[18px]" /> {label}
    </button>
  );
}
