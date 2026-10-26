// Hunt 3 (2026-10-27), shell-3: a render crash in the authenticated SHELL (header, bell,
// tab bar, account panel, push nudge - everything app/(app)/layout.tsx renders beside the
// page), or a getWorkspace() throw on a refresh, is caught by app/error.tsx, the ROOT
// boundary, which wraps the whole (app) layout. That unmounts ErrorMonitor, whose
// layout-effect cleanup used to set reporter = null BEFORE the root card's passive effect
// called reportCaughtRenderError - so nothing reached client_errors, though the user was
// signed in the whole time.
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { useState } from "react";
import { render, screen, cleanup, act } from "@testing-library/react";

const h = vi.hoisted(() => ({ log: vi.fn(async () => true) }));
vi.mock("@/lib/client-log", () => ({ logClientError: h.log }));

import { ErrorMonitor } from "@/components/error-monitor";
import RootError from "@/app/error";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";

let crashBell: () => void = () => {};
function Bell(): React.ReactElement {
  const [broken, setBroken] = useState(false);
  crashBell = () => setBroken(true);
  if (broken) throw new Error("Cannot read properties of null (reading 'created_at')");
  return <span>bell</span>;
}

afterEach(() => cleanup());

describe("a render crash in the (app) shell chrome", () => {
  it("is recorded in client_errors, as the signed-in user", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      // app/error.tsx's boundary > the (app) layout (ErrorMonitor + header ...)
      <ErrorBoundary errorComponent={RootError as never}>
        <ErrorMonitor userId="u1" tenantId="t1" />
        <Bell />
      </ErrorBoundary>
    );
    expect(screen.getByText("bell")).toBeTruthy();
    // new data arrives later and the bell cannot render it
    await act(async () => crashBell());
    expect(await screen.findByText("หน้านี้มีปัญหา")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    spy.mockRestore();
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", tenantId: "t1", kind: "react" })
    );
  });
});
