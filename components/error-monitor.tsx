"use client";

import { Component, useEffect, type ReactNode } from "react";
import { logClientError } from "@/lib/client-log";
import { Button } from "@/components/ui/button";

/**
 * Global client-error capture. Mounted once in the (app) layout. Installs window
 * 'error' + 'unhandledrejection' listeners that forward to logClientError
 * (deduped/throttled/self-silencing). Renders nothing.
 */
export function ErrorMonitor({
  userId,
  tenantId,
}: {
  userId: string;
  tenantId: string | null;
}) {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      logClientError({
        userId,
        tenantId,
        kind: "error",
        message: e.message || String(e.error ?? "unknown error"),
        stack: (e.error as Error | undefined)?.stack ?? null,
        url: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : null,
      });
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { message?: string; stack?: string } | undefined;
      logClientError({
        userId,
        tenantId,
        kind: "unhandledrejection",
        message: r?.message ? String(r.message) : String(e.reason),
        stack: r?.stack ?? null,
      });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [userId, tenantId]);
  return null;
}

/**
 * Catch React RENDER crashes (the "white screen") — log them + show a friendly
 * fallback with a reload, instead of an unmounted blank page mid-show.
 */
export class AppErrorBoundary extends Component<
  { userId: string; tenantId: string | null; children: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: Error) {
    logClientError({
      userId: this.props.userId,
      tenantId: this.props.tenantId,
      kind: "react",
      message: error?.message || "render crash",
      stack: error?.stack ?? null,
    });
  }

  render() {
    if (this.state.crashed) {
      return (
        <div className="grid min-h-[60vh] place-items-center p-6 text-center">
          <div className="space-y-3">
            <h1 className="text-lg font-semibold">เกิดข้อผิดพลาดบางอย่าง</h1>
            <p className="text-sm text-muted-foreground">
              ระบบบันทึกปัญหานี้ไว้ให้แล้ว — ลองโหลดหน้าใหม่อีกครั้ง
            </p>
            <Button onClick={() => window.location.reload()}>โหลดหน้าใหม่</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
