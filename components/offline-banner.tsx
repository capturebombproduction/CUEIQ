"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/**
 * Thin top strip shown whenever the device goes offline, so an operator mid-show
 * knows the app is now running on cached data + on-device audio (not live).
 * Live Mode keeps its own realtime "การเชื่อมต่อหลุด" banner for sync state — this
 * one is the app-wide network indicator.
 */
export function OfflineBanner() {
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

  if (!offline) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-2 bg-amber-500 px-3 py-1.5 text-center text-xs font-semibold text-black shadow-md">
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      ออฟไลน์ — กำลังใช้ข้อมูลและไฟล์เพลงที่บันทึกไว้ในเครื่อง
    </div>
  );
}
