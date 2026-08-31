// ---------------------------------------------------------------------------
// EVERY NOTIFICATION MUST OPEN SOMETHING — IN BOTH APPS.
//
// /api/notify and the daily reminder cron both stamp a `link` on the row; the bell
// navigates to whatever the row says. There are two routers behind that one string: Next's file tree on the web,
// and desktop/src/App.tsx's <Route> table in the .exe, whose catch-all is
// `<Route path="*" element={<Navigate to="/" replace />} />`.
//
// So a destination that exists only on the web does not 404 on the desktop — it
// SILENTLY BOUNCES TO THE DASHBOARD. The user taps "ทีมงานตอบฟีดแบคของคุณแล้ว",
// lands on the dashboard, and concludes the answer is not there. That is exactly
// what happened when /feedback was added on 2026-08-31: the web page was written,
// the notification was wired, and the desktop route was forgotten. Nothing failed.
// Nothing was red. It just quietly did nothing, which is the failure mode this
// whole feedback change exists to stop.
//
// This test reads the two routers and the link producers as TEXT rather than
// importing them (app/api/notify/route.ts pulls in next/server and the R2 client),
// and it deliberately fails on a link shape it does not recognise: a new
// destination should have to be looked at, not pattern-matched past.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), "utf8");

/** `/events/${ev.id}` → `/events/:param`, so one shape can be matched against a
 *  route pattern regardless of what the id is called at the call site. */
function normalize(literal: string): string {
  return literal.replace(/\$\{[^}]*\}/g, ":param");
}

/**
 * Every destination either producer can put on a row.
 *
 * `link = "…"` / `link = \`…\`` are taken verbatim. `link = IDENTIFIER` is NOT
 * guessed: the identifier has to be resolvable from the small table below, and an
 * unknown one fails the test rather than being skipped — a silently-ignored
 * destination is the bug this file is about.
 */
function notifyLinkShapes(): string[] {
  // BOTH producers of notification rows. The cron was added to this list on
  // 2026-08-31 when it grew a third block: it writes the same `notifications`
  // table and its link is followed by the same bell, so a destination it invents
  // has exactly the same two routers to satisfy.
  const routeSrc =
    read("app/api/notify/route.ts") + read("app/api/cron/reminders/route.ts");
  const deadLinkSrc = read("lib/dead-link.ts");

  // Constants and helpers the route assigns to `link` instead of a literal.
  const resolved: Record<string, string> = {};
  const constMatch = /export const RUN_ORDER_FALLBACK_LINK = "([^"]+)"/.exec(deadLinkSrc);
  expect(constMatch, "RUN_ORDER_FALLBACK_LINK is no longer a plain string literal").not.toBeNull();
  resolved.RUN_ORDER_FALLBACK_LINK = constMatch![1];

  // runOrderLiveLink() never reaches `link =` in the route — dead-link.ts hands it
  // straight to the per-recipient link map — so it is collected from its own source.
  const liveLink = /export function runOrderLiveLink\([^)]*\)[^{]*\{\s*return `([^`]+)`/.exec(
    deadLinkSrc
  );
  expect(liveLink, "runOrderLiveLink no longer returns a single template literal").not.toBeNull();

  const shapes = new Set<string>([normalize(liveLink![1])]);

  const assignments = [...routeSrc.matchAll(/\blink = (`[^`]*`|"[^"]*"|[A-Za-z_$][\w$]*)/g)];
  expect(assignments.length, "no `link =` assignments found — did a route change shape?")
    .toBeGreaterThan(0);

  for (const [, raw] of assignments) {
    if (raw.startsWith("`") || raw.startsWith('"')) {
      shapes.add(normalize(raw.slice(1, -1)));
      continue;
    }
    const known = resolved[raw];
    expect(
      known,
      `A notification producer assigns link = ${raw}, which this test cannot resolve. ` +
        `Add it to the table in lib/notify-link-routes.test.ts and make sure BOTH routers ` +
        `can open it — an unroutable link bounces to the dashboard on the desktop.`
    ).toBeTruthy();
    shapes.add(normalize(known));
  }
  return [...shapes].sort();
}

/** The <Route path="…"> table in the packaged app. */
function desktopRoutes(): string[] {
  const src = read("desktop/src/App.tsx");
  return [...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1]);
}

/** Does `link` land on `route`, treating any `:name` segment as a wildcard? */
function matches(link: string, route: string): boolean {
  if (route === "*") return false; // the catch-all is the failure, not a match
  const l = link.split("/");
  const r = route.split("/");
  if (l.length !== r.length) return false;
  return r.every((seg, i) => seg.startsWith(":") || seg === l[i]);
}

/** The Next.js file-tree equivalent: /events/:param → app/(app)/events/[id]/page.tsx */
function webRouteExists(link: string): boolean {
  const dir = path.join(
    repoRoot,
    "app/(app)",
    ...link
      .split("/")
      .filter(Boolean)
      .map((seg) => (seg.startsWith(":") ? "[id]" : seg))
  );
  return fs.existsSync(path.join(dir, "page.tsx"));
}

describe("notification links open a real page in BOTH apps", () => {
  const shapes = notifyLinkShapes();

  it("finds every destination a notification can carry", () => {
    // Pinned so that ADDING a kind without thinking about its destination shows up
    // here as a diff rather than sliding through the loops below.
    expect(shapes).toEqual([
      "/events/:param",
      "/events/:param/run-order/live",
      "/feedback",
      "/library",
      "/overview",
    ]);
  });

  it.each(shapes)("%s has a route in the desktop app", (link) => {
    const routes = desktopRoutes();
    expect(
      routes.some((r) => matches(link, r)),
      `desktop/src/App.tsx has no <Route> for ${link}. It will NOT 404 — the catch-all ` +
        `redirects to /, so the notification will look like it opened the dashboard on purpose.`
    ).toBe(true);
  });

  it.each(shapes)("%s has a page in the web app", (link) => {
    expect(webRouteExists(link), `no app/(app) page.tsx for ${link}`).toBe(true);
  });
});
