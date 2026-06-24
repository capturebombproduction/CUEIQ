"use client";

import { useEffect, useState } from "react";
import { SlidersHorizontal, Eye, Volume2, VolumeX, Wifi, WifiOff, CloudUpload } from "lucide-react";
import { cn } from "@/lib/utils";
import { deviceLabel } from "@/lib/device-id";
import { pendingCount, flushOutbox } from "@/lib/show-run-outbox";

/**
 * At-a-glance "what is THIS device right now" strip for Live Mode — the prominent
 * status indicator docs/offline-first-plan.md §11-D asks for ("เครื่องนี้คือ MAIN
 * เด่นมาก กันหยิบผิดเครื่อง"). Built entirely on existing state + the show-run
 * outbox; no authority table needed yet:
 *   • Show Main  = this device is the show controller (isController)
 *   • Audio Host = this device's sound output is on (soundOutput)
 *   • network    = online / offline
 *   • sync       = pending offline writes waiting to upload
 * Display-only; changes nothing about control or audio.
 */
export function LiveStatusStrip({
  isController,
  soundOutput,
}: {
  isController: boolean;
  soundOutput: boolean;
}) {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [label, setLabel] = useState("");

  useEffect(() => {
    setLabel(deviceLabel());
    setOnline(navigator.onLine !== false);
    const refreshPending = () => pendingCount().then(setPending).catch(() => {});
    refreshPending();
    const onUp = () => {
      setOnline(true);
      // a reconnect drains the outbox (also done app-wide) — reflect it here soon after
      flushOutbox().finally(refreshPending);
    };
    const onDown = () => setOnline(false);
    const id = setInterval(refreshPending, 15000);
    window.addEventListener("online", onUp);
    window.addEventListener("offline", onDown);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", onUp);
      window.removeEventListener("offline", onDown);
    };
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {/* Show Main — loud when this device is the controller, so you don't drive
          the show from the wrong device. */}
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-semibold",
          isController
            ? "border-primary/50 bg-primary/15 text-primary"
            : "border-border bg-muted/40 text-muted-foreground"
        )}
        title={isController ? "เครื่องนี้กำลังคุมโชว์ (Show Main)" : "เครื่องนี้ดูอย่างเดียว"}
      >
        {isController ? (
          <>
            <SlidersHorizontal className="h-3.5 w-3.5" /> คุมโชว์
          </>
        ) : (
          <>
            <Eye className="h-3.5 w-3.5" /> ดูอย่างเดียว
          </>
        )}
        {label && <span className="font-mono font-normal opacity-70">· {label}</span>}
      </span>

      {/* Audio Host — is this the device the sound comes out of? */}
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-medium",
          soundOutput
            ? "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400"
            : "border-border bg-muted/40 text-muted-foreground"
        )}
        title={soundOutput ? "เสียงออกเครื่องนี้ (Audio Host)" : "เครื่องนี้ปิดเสียง"}
      >
        {soundOutput ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
        {soundOutput ? "เสียงออกเครื่องนี้" : "ปิดเสียง"}
      </span>

      {/* Network */}
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-medium",
          online
            ? "border-border bg-muted/40 text-muted-foreground"
            : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        )}
        title={online ? "ออนไลน์" : "ออฟไลน์ — โชว์เดินจากเครื่องนี้"}
      >
        {online ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
        {online ? "ออนไลน์" : "ออฟไลน์"}
      </span>

      {/* Pending offline writes still to sync */}
      {pending > 0 && (
        <span
          className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-medium text-amber-700 dark:text-amber-400"
          title="ข้อมูลโชว์ที่บันทึกตอนออฟไลน์ รอซิงค์ขึ้นเซิร์ฟเวอร์เมื่อกลับมาออนไลน์"
        >
          <CloudUpload className="h-3.5 w-3.5" /> รอซิงค์ {pending}
        </span>
      )}
    </div>
  );
}
