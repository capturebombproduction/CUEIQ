"use client";

import { useEffect } from "react";

// Root-level error boundary. Next shows a bare "Application error: a client-side
// exception has occurred" when something throws above every route boundary — most
// painfully when an OFFLINE soft navigation can't fetch its RSC payload and bubbles
// all the way up (the white-screen dead-end). Here we recover: if we're offline,
// hard-load the universal offline shell (served from cache by the SW, boots from
// IndexedDB) instead of stranding the user. Guarded against a redirect loop.
// global-error must render its own <html>/<body> and can't rely on app CSS, so the
// styling is inline. See docs/offline-first-plan.md P1.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    if (offline) {
      try {
        if (!sessionStorage.getItem("cueiq:offlineRecover")) {
          sessionStorage.setItem("cueiq:offlineRecover", "1");
          window.location.replace("/live-shell");
          return;
        }
      } catch {
        /* sessionStorage blocked — fall through to the manual UI */
      }
    } else {
      try {
        sessionStorage.removeItem("cueiq:offlineRecover");
      } catch {
        /* ignore */
      }
    }
    // eslint-disable-next-line no-console
    console.error("[CueIQ] global error:", error);
  }, [error]);

  return (
    <html lang="th">
      <body
        style={{
          fontFamily: "Kanit, system-ui, sans-serif",
          background: "#0b0b0f",
          color: "#eee",
          minHeight: "100vh",
          margin: 0,
          display: "grid",
          placeItems: "center",
          padding: "1.5rem",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 420 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
          <h1 style={{ margin: "0 0 .4em", fontSize: "1.25rem" }}>เกิดข้อผิดพลาด</h1>
          <p style={{ opacity: 0.8, lineHeight: 1.6, margin: "0 0 1.2em" }}>
            ถ้าอยู่ในงานและไม่มีเน็ต ให้เปิด “หน้าโชว์ออฟไลน์” เพื่อรันโชว์จากข้อมูลในเครื่องต่อได้
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => window.location.assign("/live-shell")}
              style={{
                background: "#f59e0b",
                color: "#000",
                border: 0,
                borderRadius: 8,
                padding: "10px 16px",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              เปิดหน้าโชว์ออฟไลน์
            </button>
            <button
              onClick={() => reset()}
              style={{
                background: "transparent",
                color: "#eee",
                border: "1px solid #555",
                borderRadius: 8,
                padding: "10px 16px",
                cursor: "pointer",
              }}
            >
              ลองใหม่
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
