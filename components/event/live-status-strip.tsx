"use client";

import { useEffect, useState } from "react";
import {
  SlidersHorizontal,
  Eye,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  CloudUpload,
  MonitorSmartphone,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { deviceLabel, getDeviceId, shortDeviceId } from "@/lib/device-id";
import {
  pendingCount,
  flushOutbox,
  SHOW_RUN_SAVE_EVENT,
  type ShowRunSaveOutcome,
} from "@/lib/show-run-outbox";
import { getAuthority, isGhost } from "@/lib/show-authority";

/**
 * At-a-glance "what is THIS device right now" strip for Live Mode — the prominent
 * status indicator docs/offline-first-plan.md §11-D asks for ("เครื่องนี้คือ MAIN
 * เด่นมาก กันหยิบผิดเครื่อง"). Built entirely on existing state + the show-run
 * outbox; no authority table needed yet:
 *   • Show Main  = this device is the show controller (isController)
 *   • Audio Host = this device's sound output is on (soundOutput)
 *   • network    = online / offline
 *   • sync       = pending offline writes waiting to upload — or, distinctly, that
 *                  the queue holding them could not be read at all
 *   • last-run   = a จบโชว์ whose run time could be neither sent nor queued
 * Display-only; changes nothing about control or audio.
 */
export function LiveStatusStrip({
  eventId,
  isController,
  soundOutput,
  className,
}: {
  eventId: string;
  isController: boolean;
  soundOutput: boolean;
  /** placement from the screen (e.g. the stage gutter) */
  className?: string;
}) {
  const [online, setOnline] = useState(true);
  // number = that many writes are waiting. null = THE QUEUE COULD NOT BE READ,
  // which is not zero (lib/read-guard.ts, and pendingCount's own doc). Rendering
  // the two the same way is how an operator gets told "nothing pending" about the
  // last surviving copy of the night's run time.
  const [pending, setPending] = useState<number | null>(0);
  // A จบโชว์ / ล้าง that reached neither the server nor the queue. Raised by the
  // module's own window event, because both call sites are fire-and-forget.
  const [saveLost, setSaveLost] = useState(false);
  const [label, setLabel] = useState("");
  // Cross-device awareness: who the persisted authority says is MAIN. null = no
  // recorded main (or it's this device); set when ANOTHER device holds it.
  const [otherMain, setOtherMain] = useState<{ label: string; ghost: boolean } | null>(null);

  useEffect(() => {
    setLabel(deviceLabel());
    setOnline(navigator.onLine !== false);
    // pendingCount already answers null rather than throwing; the catch is the
    // belt, and it lands on null too — never back on a confident 0.
    const refreshPending = () =>
      pendingCount()
        .then(setPending)
        .catch(() => setPending(null));
    const refreshAuthority = async () => {
      const rows = await getAuthority(eventId);
      const main = rows.find((r) => r.kind === "show_main");
      if (!main || main.device_id === getDeviceId()) {
        setOtherMain(null);
      } else {
        setOtherMain({
          label: main.device_label || shortDeviceId(main.device_id),
          ghost: isGhost(main),
        });
      }
    };
    const refresh = () => {
      refreshPending();
      if (navigator.onLine !== false) refreshAuthority().catch(() => {});
    };
    refresh();
    const onUp = () => {
      setOnline(true);
      // a reconnect drains the outbox (also done app-wide) — reflect it here soon
      // after. The .catch is load-bearing: flushOutbox's closing re-count can
      // throw on a storage failure, and `.finally()` alone would forward that
      // rejection with nothing attached to it.
      flushOutbox()
        .catch(() => {})
        .finally(refresh);
    };
    const onDown = () => setOnline(false);
    // The module announces every persistLastRun outcome (it has to: จบโชว์ calls
    // it fire-and-forget, so nothing else could ever learn that a run time was
    // neither sent nor stored). A save that later lands clears the warning.
    const onSave = (e: Event) => {
      const outcome = (e as CustomEvent<{ outcome?: ShowRunSaveOutcome }>).detail?.outcome;
      setSaveLost(outcome === "lost");
      refreshPending();
    };
    const id = setInterval(refresh, 15000);
    window.addEventListener("online", onUp);
    window.addEventListener("offline", onDown);
    window.addEventListener(SHOW_RUN_SAVE_EVENT, onSave);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", onUp);
      window.removeEventListener("offline", onDown);
      window.removeEventListener(SHOW_RUN_SAVE_EVENT, onSave);
    };
  }, [eventId]);

  // Live Mode's status row already says who controls and who sounds, so the strip
  // stands aside until something needs the operator: offline, writes waiting (or a
  // queue that could not be read), a run time that was saved nowhere, or the
  // recorded MAIN gone dark. It stays MOUNTED either way — its effects keep counting.
  const attention =
    !online || pending === null || (pending ?? 0) > 0 || saveLost || (!!otherMain?.ghost && !isController);

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", !attention && "hidden", className)}>
      {/* Show Main — loud when this device is the controller, so you don't drive
          the show from the wrong device. */}
      <span
        className={cn("chip", isController ? "chip-primary" : "chip-neutral")}
        title={isController ? "เครื่องนี้กำลังคุมโชว์ (Show Main)" : "เครื่องนี้ดูอย่างเดียว"}
      >
        {isController ? (
          <>
            <SlidersHorizontal aria-hidden /> คุมโชว์
          </>
        ) : (
          <>
            <Eye aria-hidden /> ดูอย่างเดียว
          </>
        )}
        {label && <span className="font-normal opacity-80">· {label}</span>}
      </span>

      {/* Cross-device: another device is the recorded MAIN — so you know where
          control lives (and if that device went dark, a stale = reclaimable main). */}
      {otherMain && !isController && (
        <span
          className={cn("chip", otherMain.ghost ? "chip-warning" : "chip-neutral")}
          title={
            otherMain.ghost
              ? "เครื่องที่คุมโชว์เงียบไป (ไม่เห็นสัญญาณ) — กดขอควบคุมเพื่อรับช่วงต่อได้"
              : `เครื่องที่กำลังคุมโชว์: ${otherMain.label}`
          }
        >
          {otherMain.ghost ? <AlertTriangle aria-hidden /> : <MonitorSmartphone aria-hidden />}
          {otherMain.ghost ? `MAIN เดิมหลุด · ${otherMain.label}` : `MAIN · ${otherMain.label}`}
        </span>
      )}

      {/* Audio Host — is this the device the sound comes out of? */}
      <span
        className={cn("chip", soundOutput ? "chip-success" : "chip-neutral")}
        title={soundOutput ? "เสียงออกเครื่องนี้ (Audio Host)" : "เครื่องนี้ปิดเสียง"}
      >
        {soundOutput ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />}
        {soundOutput ? "เสียงออกเครื่องนี้" : "ปิดเสียง"}
      </span>

      {/* Network */}
      <span
        className={cn("chip", online ? "chip-neutral" : "chip-warning")}
        title={online ? "ออนไลน์" : "ออฟไลน์ — โชว์เดินจากเครื่องนี้"}
      >
        {online ? <Wifi aria-hidden /> : <WifiOff aria-hidden />}
        {online ? "ออนไลน์" : "ออฟไลน์"}
      </span>

      {/* Pending offline writes still to sync. `pending !== null` is not
          defensive typing — a null here means the count is UNKNOWN, and the chip
          below is the one that says so. An empty queue is a real 0 and stays
          silent, exactly as before. */}
      {pending !== null && pending > 0 && (
        <span
          className="chip chip-warning"
          title="ข้อมูลโชว์ที่บันทึกตอนออฟไลน์ รอซิงค์ขึ้นเซิร์ฟเวอร์เมื่อกลับมาออนไลน์"
        >
          <CloudUpload aria-hidden /> รอซิงค์ <span className="num">{pending}</span>
        </span>
      )}

      {/* The queue itself could not be read. Silence here would be a claim we
          cannot back: "no chip" is what a fully-synced device looks like. */}
      {pending === null && (
        <span
          className="chip chip-warning"
          title="อ่านคิวที่รอซิงค์ในเครื่องนี้ไม่ได้ — ยังบอกไม่ได้ว่าซิงค์ครบหรือยัง อย่าเพิ่งปิดเครื่อง"
        >
          <AlertTriangle aria-hidden /> เช็คคิวซิงค์ไม่ได้
        </span>
      )}

      {/* จบโชว์ / ล้าง reached neither the server nor the queue — the loudest
          thing on the strip, because the number is now only on this screen. */}
      {saveLost && (
        <span
          className="chip chip-danger font-semibold"
          title="บันทึกเวลาโชว์ล่าสุดไม่สำเร็จ และเก็บลงคิวในเครื่องไม่ได้ด้วย — จดเวลาไว้ก่อน แล้วกดจบโชว์อีกครั้งเมื่อเน็ตกลับ"
        >
          <AlertTriangle aria-hidden /> ยังไม่ได้บันทึกเวลาโชว์
        </span>
      )}
    </div>
  );
}
