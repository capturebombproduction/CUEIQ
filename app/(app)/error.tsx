"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, RotateCw, CloudOff } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Error boundary for the whole in-app area. Without it a render error (e.g. a
 * Safari-only throw) silently blanks the page under the nav — impossible to debug
 * from a phone. This catches it, shows the real message + a reload, and logs it to
 * the console so the cause is visible instead of a mystery blank.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Offline render/navigation failures (e.g. a soft nav that can't fetch its data)
  // get a recovery path into the offline shell instead of a dead error screen.
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    setOffline(navigator.onLine === false);
    console.error("[CueIQ] in-app render error:", error);
  }, [error]);

  if (offline) {
    return (
      <div className="mx-auto max-w-md space-y-4 py-16 text-center">
        <CloudOff className="mx-auto h-10 w-10 text-amber-500" />
        <h1 className="text-xl font-bold">ออฟไลน์</h1>
        <p className="text-sm text-muted-foreground">
          ตอนนี้ไม่มีการเชื่อมต่อ จึงเปิดหน้านี้ไม่ได้ — เปิด “หน้าโชว์ออฟไลน์”
          เพื่อรันโชว์ที่เตรียมไว้ในเครื่องนี้ต่อได้
        </p>
        <div className="flex justify-center gap-2">
          <Button onClick={() => window.location.assign("/live-shell")}>
            <CloudOff className="h-4 w-4" /> เปิดหน้าโชว์ออฟไลน์
          </Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            โหลดใหม่
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4 py-16 text-center">
      <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
      <h1 className="text-xl font-bold">หน้านี้มีปัญหา</h1>
      <p className="text-sm text-muted-foreground">
        เกิดข้อผิดพลาดระหว่างแสดงผลหน้านี้ ลองโหลดใหม่อีกครั้ง — ถ้ายังไม่หาย
        ส่งข้อความสีเทาด้านล่างนี้ให้ทีมพัฒนา (โจเซฟิน) จะได้รู้สาเหตุ
      </p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-left text-xs text-muted-foreground">
        {error.message || "ไม่ทราบสาเหตุ"}
        {error.digest ? `\n\ndigest: ${error.digest}` : ""}
      </pre>
      <div className="flex justify-center gap-2">
        <Button onClick={reset}>
          <RotateCw className="h-4 w-4" /> ลองใหม่
        </Button>
        <Button variant="outline" onClick={() => window.location.reload()}>
          โหลดหน้าใหม่
        </Button>
      </div>
    </div>
  );
}
