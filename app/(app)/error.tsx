"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
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
  useEffect(() => {
    console.error("[CueIQ] in-app render error:", error);
  }, [error]);

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
