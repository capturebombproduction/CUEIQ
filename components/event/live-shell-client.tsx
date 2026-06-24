"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import {
  ArrowLeft,
  CloudOff,
  RefreshCw,
  PackageOpen,
  Radio,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// Lazy so the OFFLINE HOME (the common cold-boot view) renders from a tiny chunk set
// instead of pulling Live Mode's whole graph — if any one of those chunks weren't
// cached, even the home would fail offline. Live Mode loads only when booting a show
// (its chunks are cached from the live page / warm-up). ssr:false: shell is client-only.
const LiveMode = dynamic(
  () => import("@/components/event/live-mode").then((m) => m.LiveMode),
  {
    ssr: false,
    loading: () => (
      <div className="container flex min-h-[40vh] items-center justify-center py-10 text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> กำลังโหลดโหมดไลฟ์…
      </div>
    ),
  }
);
import {
  getEventSnapshot,
  listEventSnapshotIds,
  type EventSnapshot,
} from "@/lib/event-store";

// The UNIVERSAL OFFLINE SHELL. The service worker serves this static page for ANY
// app navigation that fails offline and isn't cached — so the app always boots with
// no network instead of dead-ending on the offline notice. Because the SW serves it
// WITHOUT changing the URL, window.location.pathname still tells us what the user
// was heading to:
//   • /events/<id>/live  → boot that show straight from its on-device snapshot.
//   • anything else       → an "offline home" listing the shows prepared on this
//                           device, each a HARD link back into its live page (which
//                           the SW serves as this shell again → boots the show).
// Every link here is a hard <a> (full navigation), never next/link — a soft (RSC)
// navigation would try to hit the network and fail offline. See docs/offline-first-plan.md P1.

function eventIdFromPath(): string | null {
  if (typeof window === "undefined") return null;
  const m = /\/events\/([^/]+)\/live/.exec(window.location.pathname);
  return m ? m[1] : null;
}

interface ShowEntry {
  id: string;
  name: string;
  savedAt: number;
}

type BootState =
  | { kind: "loading" }
  | { kind: "live"; snap: EventSnapshot }
  | { kind: "home"; shows: ShowEntry[]; missingId: string | null };

export function LiveShellClient() {
  const [boot, setBoot] = useState<BootState>({ kind: "loading" });
  const [online, setOnline] = useState(true);

  useEffect(() => {
    // The shell loaded successfully → clear the global-error recovery guard so a
    // future offline error can recover into the shell again.
    try {
      sessionStorage.removeItem("cueiq:offlineRecover");
    } catch {
      /* ignore */
    }
    setOnline(navigator.onLine !== false);
    const onUp = () => setOnline(true);
    const onDown = () => setOnline(false);
    window.addEventListener("online", onUp);
    window.addEventListener("offline", onDown);

    (async () => {
      const eventId = eventIdFromPath();
      if (eventId) {
        const snap = await getEventSnapshot(eventId).catch(() => null);
        if (snap) {
          setBoot({ kind: "live", snap });
          return;
        }
      }
      // No specific (or no prepared) show → offline home: list what IS prepared.
      const ids = await listEventSnapshotIds().catch(() => []);
      const snaps = await Promise.all(ids.map((id) => getEventSnapshot(id).catch(() => null)));
      const shows: ShowEntry[] = snaps
        .filter((s): s is EventSnapshot => !!s)
        .map((s) => ({ id: s.eventId, name: s.eventName, savedAt: s.savedAt }))
        .sort((a, b) => b.savedAt - a.savedAt);
      setBoot({ kind: "home", shows, missingId: eventId });
    })();

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

  if (boot.kind === "live") {
    const { snap } = boot;
    return (
      <div className="container space-y-4 py-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* hard link — the SW serves the shell again for these offline navigations */}
          <a
            href={`/events/${snap.eventId}`}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> กลับไปหน้างาน
          </a>
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

  // offline home
  const { shows, missingId } = boot;
  return (
    <div className="container max-w-md space-y-5 py-10">
      <div className="space-y-1 text-center">
        <CloudOff className="mx-auto h-9 w-9 text-amber-500" />
        <h1 className="text-lg font-semibold">โหมดออฟไลน์</h1>
        <p className="text-sm text-muted-foreground">
          {online
            ? "กำลังใช้ข้อมูลในเครื่อง — โหลดใหม่เพื่อกลับไปเวอร์ชันออนไลน์"
            : "ไม่มีการเชื่อมต่อ — เปิดได้เฉพาะโชว์ที่เตรียมไว้ในเครื่องนี้"}
        </p>
      </div>

      {missingId && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <PackageOpen className="mt-0.5 h-4 w-4 shrink-0" />
          งานที่เปิดยังไม่ได้เตรียมไว้ในเครื่องนี้ — เลือกจากรายการที่พร้อมด้านล่าง หรือเปิดงานนี้ขณะออนไลน์ก่อน
        </div>
      )}

      {shows.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">โชว์ที่พร้อมเล่นออฟไลน์</p>
          {shows.map((s) => (
            <a
              key={s.id}
              href={`/events/${s.id}/live`}
              className="flex items-center gap-3 rounded-lg border bg-card/50 px-3 py-3 transition hover:bg-muted"
            >
              <Radio className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </a>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          ยังไม่มีโชว์ที่เตรียมไว้ในเครื่องนี้
          <br />
          เปิดหน้างาน (และกด “เตรียมเครื่องนี้”) ขณะออนไลน์ก่อน
        </div>
      )}

      <div className="flex justify-center gap-2">
        <Button variant="outline" onClick={() => window.location.reload()}>
          <RefreshCw className="h-4 w-4" /> โหลดใหม่
        </Button>
      </div>
    </div>
  );
}
