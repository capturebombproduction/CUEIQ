"use client";

import { useEffect } from "react";

// Root-level error boundary. Next shows a bare "Application error: a client-side
// exception has occurred" when something throws above every route boundary. Here
// we catch it, log the cause, and offer a retry / full reload. (The web app is
// online-first now — offline show-running moved to the CueIQ Desktop app — so
// there's no offline shell to recover into.)
// global-error must render its own <html>/<body> and can't rely on app CSS, so the
// styling is inline.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
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
            เกิดข้อผิดพลาดในแอป ลองใหม่อีกครั้ง หรือโหลดหน้าใหม่
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => reset()}
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
              ลองใหม่
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: "transparent",
                color: "#eee",
                border: "1px solid #555",
                borderRadius: 8,
                padding: "10px 16px",
                cursor: "pointer",
              }}
            >
              โหลดหน้าใหม่
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
