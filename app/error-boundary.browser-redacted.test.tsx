// 2026-10-27 hunt (admin): what a Server-Component throw looks like IN THE
// BROWSER, where app/(app)/error.tsx and app/error.tsx actually run.
//
// The card's "redacted" branch keys on Next's English sentence, which only the NODE
// flight client produces. The BROWSER production client (the one that decodes the
// RSC payload the boundary renders from) builds the error with
// formatProdErrorMessage(441) - "Minified React error #441; ..." - and stack
// "Error: " + message. Read straight from the shipped file below.
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";

const h = vi.hoisted(() => ({ log: vi.fn<(entry: unknown) => Promise<boolean>>(async () => true) }));
vi.mock("@/lib/client-log", () => ({ logClientError: h.log }));

import { ErrorMonitor } from "@/components/error-monitor";
import AppError from "@/app/(app)/error";

afterEach(() => cleanup());

const BROWSER_CLIENT = path.resolve(
  "node_modules/next/dist/compiled/react-server-dom-turbopack/cjs/react-server-dom-turbopack-client.browser.production.js"
);

/** Exactly what resolveErrorProd() + the "E" row handler hand the boundary. */
function browserRedacted(digest: string) {
  const e = new Error(
    "Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings."
  ) as Error & { digest?: string };
  e.stack = "Error: " + e.message;
  e.digest = digest;
  return e;
}

describe("a Server-Component throw as the browser sees it", () => {
  it("(sanity) the shipped browser client builds it from error code 441, not the English sentence", () => {
    const src = fs.readFileSync(BROWSER_CLIENT, "utf8");
    expect(src).toMatch(/function resolveErrorProd\(\) \{\s*var error = Error\(formatProdErrorMessage\(441\)\);\s*error\.stack = "Error: " \+ error\.message;/);
    expect(src).not.toMatch(/An error occurred in the Server Components render/);
  });

  it("gets the 'nothing was lost' card, not React's English boilerplate", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AppError error={browserRedacted("3421887761")} />);
    expect(screen.queryByText(/ข้อมูลที่บันทึกไว้ยังอยู่ครบ/)).toBeInTheDocument();
    expect(screen.queryByText(/Minified React error/)).not.toBeInTheDocument();
  });

  it("is reported to the Dev Inbox WITH its digest (the only key to the Vercel log line)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <>
        <ErrorMonitor userId="u1" tenantId="t1" />
        <AppError error={browserRedacted("3421887761")} />
      </>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(h.log).toHaveBeenCalled();
    const arg = h.log.mock.calls.at(-1)![0] as { message: string; stack: string | null };
    expect(`${arg.message}\n${arg.stack ?? ""}`).toContain("3421887761");
  });
});
