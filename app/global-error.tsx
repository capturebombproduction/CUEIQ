"use client";

import { useEffect } from "react";

// Root-level error boundary. Next shows a bare "Application error: a client-side
// exception has occurred" when something throws above every route boundary. Here
// we catch it, log the cause, and offer a retry / full reload. (The web app is
// online-first now — offline show-running moved to the CueIQ Desktop app — so
// there's no offline shell to recover into.)
// global-error must render its own <html>/<body> and can't rely on app CSS, so the
// styling is inline: the Black Stage dark values written out (theme.css tokens are
// not loaded here), a square slab, an icon + words — never an emoji.
const C = {
  page: "hsl(0 0% 3%)",
  card: "hsl(0 0% 7%)",
  edge: "hsl(0 0% 20%)",
  ink: "hsl(0 0% 96%)",
  muted: "hsl(0 0% 68%)",
  danger: "hsl(356 78% 58%)",
};

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
          background: C.page,
          color: C.ink,
          minHeight: "100vh",
          margin: 0,
          display: "grid",
          placeItems: "center",
          padding: "1.5rem 1rem",
          textAlign: "center",
        }}
      >
        <div
          style={{
            maxWidth: 420,
            width: "100%",
            boxSizing: "border-box",
            background: C.card,
            borderRadius: 3,
            boxShadow: `inset 0 0 0 1px ${C.edge}`,
            padding: 24,
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-grid",
              placeItems: "center",
              width: 48,
              height: 48,
              borderRadius: 2,
              background: "hsl(356 78% 58% / .16)",
              color: C.danger,
              marginBottom: 12,
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          </span>
          <h1 style={{ margin: "0 0 .4em", fontSize: "1.25rem", fontWeight: 600 }}>เกิดข้อผิดพลาด</h1>
          <p style={{ color: C.muted, lineHeight: 1.6, margin: "0 0 1.2em" }}>
            เกิดข้อผิดพลาดในแอป ลองใหม่อีกครั้ง หรือโหลดหน้าใหม่
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => reset()}
              style={{
                background: C.ink,
                color: C.page,
                border: 0,
                borderRadius: 3,
                minHeight: 44,
                padding: "10px 18px",
                fontFamily: "inherit",
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              ลองใหม่
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: "transparent",
                color: C.ink,
                border: 0,
                boxShadow: `inset 0 0 0 1.5px ${C.edge}`,
                borderRadius: 3,
                minHeight: 44,
                padding: "10px 18px",
                fontFamily: "inherit",
                fontSize: 15,
                fontWeight: 600,
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
