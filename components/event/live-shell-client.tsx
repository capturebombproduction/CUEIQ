"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CloudOff, RefreshCw, PackageOpen } from "lucide-react";
import { LiveMode } from "@/components/event/live-mode";
import { Button } from "@/components/ui/button";
import { getEventSnapshot, type EventSnapshot } from "@/lib/event-store";

// The shell is served by the service worker in response to an OFFLINE navigation
// to /events/<id>/live that wasn't cached — so window.location.pathname still
// carries the real event id even though the HTML came from /live-shell.
function eventIdFromPath(): string | null {
  if (typeof window === "undefined") return null;
  const m = /\/events\/([^/]+)\/live/.exec(window.location.pathname);
  return m ? m[1] : null;
}

type BootState =
  | { kind: "loading" }
  | { kind: "ready"; snap: EventSnapshot }
  | { kind: "missing"; eventId: string | null };

/**
 * Offline cold-boot for Live Mode. When the device has no network and the live
 * page was never cached, the service worker serves this static shell; here we read
 * the show's data straight from IndexedDB (saved by EventSnapshotWriter on an
 * earlier online visit / device prep) and mount Live Mode with it. Audio comes from
 * the on-device song/audio caches exactly as it does online. The online render is
 * untouched — this only ever appears when the server can't be reached.
 * See docs/offline-first-plan.md P1.
 */
export function LiveShellClient() {
  const [boot, setBoot] = useState<BootState>({ kind: "loading" });
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine !== false);
    const onUp = () => setOnline(true);
    const onDown = () => setOnline(false);
    window.addEventListener("online", onUp);
    window.addEventListener("offline", onDown);

    const eventId = eventIdFromPath();
    if (!eventId) {
      setBoot({ kind: "missing", eventId: null });
    } else {
      getEventSnapshot(eventId)
        .then((snap) =>
          setBoot(snap ? { kind: "ready", snap } : { kind: "missing", eventId })
        )
        .catch(() => setBoot({ kind: "missing", eventId }));
    }

    return () => {
      window.removeEventListener("online", onUp);
      window.removeEventListener("offline", onDown);
    };
  }, []);

  if (boot.kind === "loading") {
    return (
      <div className="container flex min-h-[60vh] items-center justify-center py-10 text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> กำลังเปิดข้อมูลโชว์จากเครื่อง…
      </div>
    );
  }

  if (boot.kind === "missing") {
    return (
      <div className="container max-w-md space-y-4 py-10 text-center">
        <PackageOpen className="mx-auto h-10 w-10 text-muted-foreground" />
        <h1 className="text-lg font-semibold">ยังไม่ได้เตรียมงานนี้ไว้ในเครื่องนี้</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          เครื่องนี้ยังไม่มีข้อมูลโชว์ที่บันทึกไว้สำหรับเล่นออฟไลน์
          {online
            ? " ลองโหลดหน้าใหม่เพื่อดึงข้อมูลล่าสุด"
            : " — ต้องเปิดหน้างานนี้ขณะออนไลน์อย่างน้อยหนึ่งครั้ง (และกด “เตรียมเครื่องนี้”) ก่อน"}
        </p>
        <div className="flex justify-center gap-2">
          {online && (
            <Button onClick={() => window.location.reload()}>
              <RefreshCw className="h-4 w-4" /> โหลดใหม่
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href="/dashboard">
              <ArrowLeft className="h-4 w-4" /> กลับหน้าหลัก
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  const { snap } = boot;
  return (
    <div className="container space-y-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={`/events/${snap.eventId}`}>
            <ArrowLeft className="h-4 w-4" /> กลับไปหน้างาน
          </Link>
        </Button>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
          <CloudOff className="h-3.5 w-3.5" />
          โหมดออฟไลน์ — รันจากข้อมูลในเครื่อง
          {online && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="ml-1 underline underline-offset-2"
            >
              กลับออนไลน์
            </button>
          )}
        </span>
      </div>
      <LiveMode
        eventId={snap.eventId}
        groupId={snap.groupId}
        eventName={snap.eventName}
        items={snap.items}
        songAudio={snap.songAudio}
        canEdit={snap.canEdit}
        lastRunSeconds={snap.lastRunSeconds}
        lastRunAt={snap.lastRunAt}
      />
    </div>
  );
}
