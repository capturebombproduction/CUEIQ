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
  { crashed: boolean; saved: boolean | null }
> {
  /** `saved` is null until the capture answers: it is an async write and this is a
   *  sync lifecycle. See the render() note for why the screen waits for it. */
  state: { crashed: boolean; saved: boolean | null } = { crashed: false, saved: null };
  private alive = true;

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentWillUnmount() {
    // The write outlives a fast unmount; setState on a dead boundary would warn
    // and, on a page already showing a crash, warn about the crash handler.
    this.alive = false;
  }

  componentDidCatch(error: Error) {
    void logClientError({
      userId: this.props.userId,
      tenantId: this.props.tenantId,
      kind: "react",
      message: error?.message || "render crash",
      stack: error?.stack ?? null,
    })
      .then((saved) => {
        if (this.alive) this.setState({ saved });
      })
      // logClientError is documented never to throw and catches everything itself
      // — but an unhandled rejection HERE would be raised as a window
      // 'unhandledrejection', which ErrorMonitor listens for and reports, so the
      // crash handler would feed the error reporter that just failed. The one
      // place a swallow is right is the handler of last resort.
      .catch(() => {
        if (this.alive) this.setState({ saved: false });
      });
  }

  render() {
    if (this.state.crashed) {
      // WHAT THIS SCREEN IS ALLOWED TO CLAIM. It used to say "ระบบบันทึกปัญหานี้ไว้
      // ให้แล้ว" unconditionally, while logClientError swallowed every failure of its
      // own — so the one sentence a user reads at the worst moment was never checked
      // against anything. On 2026-09-04 `client_errors` held zero rows for the whole
      // life of the app, and that promise is exactly why nobody could tell a healthy
      // silence from a blind one. Now it says only what is known, and when the
      // capture did NOT land it says so and points at the channel a human reads —
      // which is the whole reason แจ้งปัญหา was made two-way.
      return (
        <div className="grid min-h-[60vh] place-items-center p-6 text-center">
          <div className="space-y-3">
            <h1 className="text-lg font-semibold">เกิดข้อผิดพลาดบางอย่าง</h1>
            <p className="text-sm text-muted-foreground" data-testid="crash-note">
              {this.state.saved === true
                ? "ระบบบันทึกปัญหานี้ไว้ให้แล้ว — ลองโหลดหน้าใหม่อีกครั้ง"
                : this.state.saved === false
                  ? "บันทึกปัญหาอัตโนมัติไม่สำเร็จ — ถ้าเจอซ้ำ รบกวนกดปุ่ม “แจ้งปัญหา” บอกเราหน่อยครับ"
                  : "ลองโหลดหน้าใหม่อีกครั้ง"}
            </p>
            <Button onClick={() => window.location.reload()}>โหลดหน้าใหม่</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
