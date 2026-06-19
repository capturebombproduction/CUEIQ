"use client";

import { useEffect, useState } from "react";
import { Maximize, Minimize } from "lucide-react";

/**
 * Toggle real fullscreen — for running Live Mode on a venue display / iPad as a
 * kiosk. Pairs with the existing Wake Lock so the screen stays on and chrome-free.
 */
export function FullscreenButton() {
  const [fs, setFs] = useState(false);

  useEffect(() => {
    const onChange = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  function toggle() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={fs ? "ออกจากโหมดเต็มจอ" : "เต็มจอ — สำหรับจอใหญ่ / iPad"}
      className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
    >
      {fs ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
      {fs ? "ออกเต็มจอ" : "เต็มจอ"}
    </button>
  );
}
