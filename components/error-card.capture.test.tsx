// On the WEB, a render crash in any (app) page used to never be written to
// client_errors.
//
// app/(app)/layout.tsx puts <AppErrorBoundary> (the component that logs a crash and
// says "ระบบบันทึกปัญหานี้ไว้ให้แล้ว") around `{children}` - but `children` of that
// layout is Next's own ErrorBoundary for app/(app)/error.tsx (error.tsx is nested
// INSIDE its segment's layout), and the page sits inside THAT. So the inner Next
// boundary catches every page crash first and renders ErrorCard, which only
// console.error()s. In production Next's onCaughtError for an explicit error.tsx is
// console.error only (node_modules/next/dist/client/react-client-callbacks/
// error-boundary-callbacks.js), so ErrorMonitor's window 'error' listener never sees
// it either. Live Mode white-screens on the web leave no trace in the Dev Inbox.
//
// The tree below is the real one (app/(app)/layout.tsx): ErrorMonitor beside
// AppErrorBoundary > Next's ErrorBoundary(AppError) > page. The card now reports
// through ErrorMonitor (reportCaughtRenderError).
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";

const h = vi.hoisted(() => ({ log: vi.fn(async () => true) }));
vi.mock("@/lib/client-log", () => ({ logClientError: h.log }));

import { AppErrorBoundary, ErrorMonitor } from "@/components/error-monitor";
import AppError from "@/app/(app)/error";
// the boundary Next wraps every segment's error.tsx in
import { ErrorBoundary } from "next/dist/client/components/error-boundary";

function LivePageThatCrashes(): React.ReactElement {
  throw new Error("Cannot read properties of undefined (reading 'audio_path')");
}

afterEach(() => cleanup());

describe("a page render crash under the (app) layout", () => {
  it("is recorded in client_errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <>
        <ErrorMonitor userId="u1" tenantId="t1" />
        <AppErrorBoundary userId="u1" tenantId="t1">
          <ErrorBoundary errorComponent={AppError as never}>
            <LivePageThatCrashes />
          </ErrorBoundary>
        </AppErrorBoundary>
      </>,
    );
    // the user sees the in-app card (Next's boundary caught it)…
    expect(await screen.findByText("หน้านี้มีปัญหา")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    spy.mockRestore();
    // …and the crash is written to client_errors as who was signed in
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", tenantId: "t1", kind: "react" }),
    );
  });
});
