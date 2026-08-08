import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import RootError from "./error";
import AppError from "./(app)/error";

// ─────────────────────────────────────────────────────────────────────────────
// THE TRIPWIRE FOR WHERE A getWorkspace() THROW LANDS.
//
// Round 11 made getWorkspace() throw rather than answer "you are not in a band"
// when one of its four reads fails. It is called from app/(app)/layout.tsx, and
// Next never lets an error.tsx catch a throw from the layout in its own segment —
// so the whole change depends on app/error.tsx existing one level up. Nothing
// tested that: deleting app/error.tsx left the entire suite green while every
// authenticated page's failure quietly reverted to global-error, which replaces the
// root layout and cannot show the digest the copy asks the operator to send.
//
// THE IMPORTS AT THE TOP ARE HALF THE TEST. A rename, a move, or a delete fails
// this file at module load, which is the cheapest possible assertion about a file's
// existence at an exact path.
//
// What this canNOT check, stated so nobody reads it as more than it is: whether
// Next's boundary hierarchy still routes a layout throw here. That was verified by
// reading create-component-tree/layout-router in next 15.5.22 and is recorded in
// lib/queries.ts; a Next upgrade that changed it would pass this file.
// ─────────────────────────────────────────────────────────────────────────────

const reload = vi.fn();
let realLocation: Location;

beforeEach(() => {
  reload.mockClear();
  realLocation = window.location;
  // jsdom's location.reload throws "not implemented"; the assertion is about the
  // CALL, so replace the whole object rather than spying on a getter-only prop.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...realLocation, reload },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

/** What Next substitutes for every Server-Component throw in production. */
const REDACTED = Object.assign(
  new Error(
    "An error occurred in the Server Components render. The specific message is " +
      "omitted in production builds to avoid leaking sensitive details."
  ),
  { digest: "3421887761" }
);

describe.each([
  ["root (catches the (app) layout, i.e. every getWorkspace throw)", RootError],
  ["in-app (catches a page below the layout)", AppError],
])("%s error boundary", (_label, Boundary) => {
  it("renders the shared card, not Next's English boilerplate", () => {
    render(<Boundary error={REDACTED} />);
    // The redacted branch: the operator is told their data is intact and given the
    // digest, instead of the 40-word English paragraph Next hands the client.
    expect(screen.getByText(/ข้อมูลที่บันทึกไว้ยังอยู่ครบ/)).toBeInTheDocument();
    expect(screen.getByText(/digest: 3421887761/)).toBeInTheDocument();
    expect(screen.queryByText(/omitted in production builds/)).not.toBeInTheDocument();
  });

  it("offers exactly one recovery, and it is one that works", () => {
    // Not a style preference. The old card's PRIMARY button called Next's reset(),
    // which cannot recover a Server-Component throw — it re-reads the same errored
    // Flight element and throws again — so the obvious button did nothing for the
    // error class this boundary now mostly catches. A second button is allowed back
    // only when someone has proven it recovers something.
    render(<Boundary error={REDACTED} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    buttons[0].click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows a client-side error's real message, which is not redacted", () => {
    render(<Boundary error={new Error("Cannot read properties of null (reading 'x')")} />);
    expect(screen.getByText(/Cannot read properties of null/)).toBeInTheDocument();
  });
});
