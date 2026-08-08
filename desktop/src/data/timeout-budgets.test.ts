// What the desktop's timeout bounds are ALLOWED TO BE — the half the other timeout
// tests in this directory cannot see.
//
// Every one of those tests pins the MECHANISM. Each advances `X_TIMEOUT_MS - 1`
// using the constant IMPORTED FROM the module under test, then one more tick, and
// asserts the cache is served. That is the right shape: the assertion moves when the
// constant moves, and it goes red the moment a call site stops using the constant.
// But it is blind to the constant's VALUE by construction. Set EVENT_BUNDLE_TIMEOUT_MS,
// SONG_LIBRARY_TIMEOUT_MS and WORKSPACE_AUTH_TIMEOUT_MS to 9_000_000 and the entire
// suite stays green — along with tsc, lint and the encoding check.
//
// The edit that does that does not look like a bug and is not made carelessly.
// Someone at a venue reports "the cache kicks in too early on the slow hotspot"; the
// obvious fix is to raise the number; every gate agrees. What ships is a Show Runner
// that sits on its spinner for ten minutes with the run sheet, the setlist and the
// mic map already on disk — precisely the failure these bounds were added to remove,
// reintroduced by a one-token edit that nothing objected to.
//
// So this file asserts the other half: an argued CEILING for every exported timeout,
// plus the worst-case TOTALS for the paths a human actually waits through. It is
// deliberately the only place in the desktop tree where a timeout VALUE is judged, so
// there is exactly one file to read before changing one.
//
// ── the question every number here answers ────────────────────────────────────
//
//   How long may an operator stare at a spinner before we serve what is already
//   on disk?
//
// Not "how slow can a venue hotspot be". The cached copy is not a degraded fallback
// at a venue — it is usually the SAME data, written by this device's last online
// session for exactly this moment. So the cost of waiting longer is not "we might
// get fresher data", it is "we hide data we are holding, from someone at load-in who
// needs it now". That asymmetry is what makes these ceilings arguable at all.
//
// The human budget, from the same load-in the read-caches were built for:
//
//   • Under ~10s to a useful screen, nobody notices.
//   • Around 30s the operator starts pressing ลองใหม่ or force-quitting the app.
//     A force-quit makes it strictly worse: it restarts the whole stack, including
//     App.tsx's boot gate, and pays every bound again from zero.
//   • Past ~40s the operator has concluded the app is broken and has gone to run the
//     show off a phone or a printout. That is the outcome the caches exist to
//     prevent, and no amount of freshness is worth reaching it.
//
// The ceilings below are derived from that, then applied per KIND of wait (auth,
// one read, a parallel batch, a secondary probe) rather than per module, so two
// modules doing the same kind of wait cannot drift apart. Today every constant sits
// under its ceiling with room for ONE tuning step — that headroom is on purpose, and
// it is not room to double everything.
//
// ⚠️ The totals are the part that matters most, and the part no single-constant
// assertion can reach: each bound can be individually defensible while the stack
// they form is well past what a person will wait. Two of the three have headroom.
// The third — the run-order builder, which stacks five bounds on one constant — is
// already past the budget above and is pinned at exactly its measured value, so it
// can get better but not worse. That is a finding, not an endorsement; it is spelled
// out at RUN_ORDER_BUILD_CEILING_MS.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  EVENT_BUNDLE_BATCH_TIMEOUT_MS,
  EVENT_BUNDLE_SESSION_TIMEOUT_MS,
  EVENT_BUNDLE_TIMEOUT_MS,
} from "./event-bundle";
import { EVENTS_LIST_SESSION_TIMEOUT_MS, EVENTS_LIST_TIMEOUT_MS } from "./events-list";
import { RUN_ORDER_TIMEOUT_MS } from "./run-order";
import { SONG_LIBRARY_TIMEOUT_MS } from "./song-library";
import { WORKSPACE_AUTH_TIMEOUT_MS, WORKSPACE_READ_TIMEOUT_MS } from "./workspace";

// ── ceilings, by kind of wait ─────────────────────────────────────────────────

/** One PostgREST select. A congested venue hotspot answers a single select in
 *  single-digit seconds — the 8s the modules use is already several times that.
 *  Past 12s the network is not slow, it is black-holed, and these reads STACK
 *  (two deep in loadWorkspace, up to five in loadRunOrderBuild), so 12s each is
 *  already a half-minute screen before anything else is counted. */
const SINGLE_READ_CEILING_MS = 12_000;

/** getUser() on a cold start. It buys no data — nothing else may begin until it
 *  answers — so every millisecond is dead time in front of EVERY screen. Ceiling
 *  is one read budget as the modules set it today: auth may never be allowed to
 *  cost more than fetching the data it unlocks. */
const AUTH_CEILING_MS = 8_000;

/** The seven-select child batch in loadEventBundleStatus, which settles with its
 *  SLOWEST leg (members and songs for a whole band are in there). The one bound in
 *  the app that legitimately exceeds a single read — see EVENT_BUNDLE_BATCH_TIMEOUT_MS
 *  for the congested-but-working hotspot it was raised for. Ceiling is three single-read
 *  budgets: seven parallel reads may cost triple one read, never more. A hotspot that
 *  cannot land seven selects in 24s is not delivering this show tonight; the cached
 *  bundle is. */
const CHILD_BATCH_CEILING_MS = 24_000;

/** A "was that empty answer really empty?" session probe. SECONDARY — it only runs
 *  after a read has already answered — and getSession() is a localStorage read plus,
 *  at worst, one refresh POST. Its expiry is free: a timeout takes the same
 *  keep-the-cache branch a slow answer would have produced. So it is the cheapest
 *  place to stop paying on a limping network and must stay a rounding error next to
 *  the read budgets it stacks on top of. */
const SESSION_PROBE_CEILING_MS = 3_000;

interface Budget {
  readonly name: string;
  readonly ms: number;
  readonly ceilingMs: number;
  readonly ceilingName: string;
  /** The human budget this number serves. Goes into the failure message, because a
   *  reader who trips this assertion needs the argument, not just the number. */
  readonly why: string;
}

const BUDGETS: readonly Budget[] = [
  {
    name: "WORKSPACE_AUTH_TIMEOUT_MS",
    ms: WORKSPACE_AUTH_TIMEOUT_MS,
    ceilingMs: AUTH_CEILING_MS,
    ceilingName: "AUTH_CEILING_MS",
    why:
      "It is the first bound on a cold start and it buys no data: nothing on any screen " +
      "may begin until getUser() answers, so this is dead time in front of the whole app. " +
      "App.tsx bounds the same call at 5s for its boot gate; a looser bound here only moves " +
      "that hang one layer down, into the Shell, which is the bug this constant was added for.",
  },
  {
    name: "WORKSPACE_READ_TIMEOUT_MS",
    ms: WORKSPACE_READ_TIMEOUT_MS,
    ceilingMs: SINGLE_READ_CEILING_MS,
    ceilingName: "SINGLE_READ_CEILING_MS",
    why:
      "Two of these stack inside one loadWorkspace, in front of every screen, and the " +
      "owner-checked cached workspace is already on disk. Past the ceiling we are hiding " +
      "a workspace we hold from an operator at load-in in exchange for freshness they did " +
      "not ask for.",
  },
  {
    name: "EVENTS_LIST_TIMEOUT_MS",
    ms: EVENTS_LIST_TIMEOUT_MS,
    ceilingMs: SINGLE_READ_CEILING_MS,
    ceilingName: "SINGLE_READ_CEILING_MS",
    why:
      "The dashboard's own list, which is sitting in localStorage while this waits — and " +
      "it waits AFTER loadWorkspace has already spent its two read budgets, so it is the " +
      "fourth stacked bound on the way to the first useful screen.",
  },
  {
    name: "EVENTS_LIST_SESSION_TIMEOUT_MS",
    ms: EVENTS_LIST_SESSION_TIMEOUT_MS,
    ceilingMs: SESSION_PROBE_CEILING_MS,
    ceilingName: "SESSION_PROBE_CEILING_MS",
    why:
      "The last thing between a black-holed network and the cached dashboard, and the only " +
      "thing given up when it expires is write-through of an EMPTY list — by definition the " +
      "case with nothing to lose. It is the cheapest bound in the boot path to keep short " +
      "and the most expensive one to lengthen.",
  },
  {
    name: "EVENT_BUNDLE_TIMEOUT_MS",
    ms: EVENT_BUNDLE_TIMEOUT_MS,
    ceilingMs: SINGLE_READ_CEILING_MS,
    ceilingName: "SINGLE_READ_CEILING_MS",
    why:
      "One select for the show's own row, on the screen someone opens while the band loads " +
      "in. It is also paid once per event by the dashboard's เตรียมทุกงาน loop, so raising " +
      "it multiplies across every show on the list, not just the one being opened.",
  },
  {
    name: "EVENT_BUNDLE_BATCH_TIMEOUT_MS",
    ms: EVENT_BUNDLE_BATCH_TIMEOUT_MS,
    ceilingMs: CHILD_BATCH_CEILING_MS,
    ceilingName: "CHILD_BATCH_CEILING_MS",
    why:
      "Seven parallel selects settling with the slowest — already the largest bound in the " +
      "app's read path, and deliberately so, because a congested hotspot answering in 9s is " +
      "working and must be allowed to deliver the show. Three single-read budgets is where " +
      "that argument runs out.",
  },
  {
    name: "EVENT_BUNDLE_SESSION_TIMEOUT_MS",
    ms: EVENT_BUNDLE_SESSION_TIMEOUT_MS,
    ceilingMs: SESSION_PROBE_CEILING_MS,
    ceilingName: "SESSION_PROBE_CEILING_MS",
    why:
      "A secondary probe that runs only when the event row came back empty, to tell a real " +
      "deletion from an anon RLS refusal. A timeout already takes the safe branch, so length " +
      "here buys nothing and is paid on the show screen.",
  },
  {
    name: "RUN_ORDER_TIMEOUT_MS",
    ms: RUN_ORDER_TIMEOUT_MS,
    ceilingMs: SINGLE_READ_CEILING_MS,
    ceilingName: "SINGLE_READ_CEILING_MS",
    why:
      "One read of the festival board — the one screen a whole festival reads, at the one " +
      "place the wifi is worst. Note this constant is used for the module's session probes " +
      "as well as its reads, so loadRunOrderBuild stacks FIVE of it; see the run-order total " +
      "below before reading this ceiling as the screen's budget.",
  },
  {
    name: "SONG_LIBRARY_TIMEOUT_MS",
    ms: SONG_LIBRARY_TIMEOUT_MS,
    ceilingMs: SINGLE_READ_CEILING_MS,
    ceilingName: "SINGLE_READ_CEILING_MS",
    why:
      "คลังเพลง is the only door to the offline audio-upload queue, and the catalogue behind " +
      "it is cached. It is also warmed silently from the dashboard, where a long bound is " +
      "time the app spends holding a request open on a network that is already failing.",
  },
];

// ── worst-case totals: what actually reaches the operator ─────────────────────

type Step = readonly [label: string, ms: number];

/** Cold dashboard, on a network that is JOINED but black-holed — every bound expires.
 *
 *  Serial by construction, not by accident: loadWorkspace's reads only start once
 *  getUser() has answered, and pages/dashboard.tsx only calls loadEventsList once
 *  `ws.membership` exists. warmSongLibrary is NOT in this list because it is fired
 *  without await and cannot delay what the dashboard paints.
 *
 *  ⚠️ This total EXCLUDES App.tsx's BOOT_SESSION_TIMEOUT_MS (5s), which is paid ahead
 *  of all of it on a cold start. That constant is not exported, so this file cannot
 *  import it and will not pretend to cover it — the real click-to-dashboard wait is
 *  about five seconds worse than whatever this asserts, which is a reason the ceiling
 *  below is not generous. */
const DASHBOARD_BOOT: readonly Step[] = [
  ["workspace / getUser", WORKSPACE_AUTH_TIMEOUT_MS],
  ["workspace / tenant_members + group_roles", WORKSPACE_READ_TIMEOUT_MS],
  ["workspace / tenants + groups", WORKSPACE_READ_TIMEOUT_MS],
  ["events list / the dashboard read", EVENTS_LIST_TIMEOUT_MS],
  ["events list / empty-answer session probe", EVENTS_LIST_SESSION_TIMEOUT_MS],
];
const DASHBOARD_BOOT_CEILING_MS = 35_000;

/** Opening ONE show, on a network that answers the event row and then goes black.
 *
 *  EVENT_BUNDLE_SESSION_TIMEOUT_MS is deliberately absent: the probe runs only when
 *  the event row came back EMPTY, which returns without ever reaching the batch, so
 *  the two are alternatives and adding both would overstate this path. */
const EVENT_OPEN: readonly Step[] = [
  ["event bundle / the event row", EVENT_BUNDLE_TIMEOUT_MS],
  ["event bundle / the seven-read child batch", EVENT_BUNDLE_BATCH_TIMEOUT_MS],
];
const EVENT_OPEN_CEILING_MS = 32_000;

/** The festival running-order BUILDER, which stacks the most bounds of any screen:
 *  the festival event row, the day's band events, their stage slots, the sequence,
 *  and then the empty-answer session probe — five, all on the same constant.
 *
 *  This ceiling is MEASURED, not endorsed: at today's 8s it is 40s, which is past the
 *  human budget the two ceilings above are derived from. It is pinned at exactly the
 *  current total so the worst screen in the app cannot quietly get worse. Lowering it
 *  is a real improvement and this assertion will never stand in the way — the module
 *  giving its session probes their own short budget, the way events-list and
 *  event-bundle already do, would take a third of it off. Raising it needs the same
 *  deliberate decision as the two above. (The live caller walks three of the same five
 *  steps, so it is covered by this bound and cannot exceed it.) */
const RUN_ORDER_BUILD: readonly Step[] = [
  ["run order / the festival event row", RUN_ORDER_TIMEOUT_MS],
  ["run order / the day's band events", RUN_ORDER_TIMEOUT_MS],
  ["run order / their stage slots", RUN_ORDER_TIMEOUT_MS],
  ["run order / the sequence", RUN_ORDER_TIMEOUT_MS],
  ["run order / empty-answer session probe", RUN_ORDER_TIMEOUT_MS],
];
const RUN_ORDER_BUILD_CEILING_MS = 40_000;

// ── helpers ───────────────────────────────────────────────────────────────────

const secs = (ms: number) => `${ms}ms (${Math.round(ms / 100) / 10}s)`;

const total = (steps: readonly Step[]) => steps.reduce((sum, [, ms]) => sum + ms, 0);

const arithmetic = (steps: readonly Step[]) =>
  steps.map(([label, ms]) => `${label} ${ms}`).join(" + ");

const ceilingFailure = (b: Budget) =>
  [
    `${b.name} is ${secs(b.ms)}; the ceiling for this kind of wait is ${b.ceilingName} = ` +
      `${secs(b.ceilingMs)}.`,
    `Why that ceiling: ${b.why}`,
    "Raising a bound past it is a PRODUCT decision about how long a venue waits with the",
    "answer already on disk — not a tuning detail. If that is the decision, raise",
    `${b.ceilingName} in desktop/src/data/timeout-budgets.test.ts in the SAME commit and`,
    "write down what changed about the venue. Do not raise only the constant, and do not",
    "delete this assertion: the mechanism tests will stay green either way, which is exactly",
    "why this one exists.",
  ].join(" ");

const totalFailure = (
  label: string,
  steps: readonly Step[],
  ceilingName: string,
  ceilingMs: number
) =>
  [
    `${label}: worst case is now ${secs(total(steps))} — ${arithmetic(steps)} — against a`,
    `ceiling of ${ceilingName} = ${secs(ceilingMs)}.`,
    "That total is the number that actually reaches the operator, and NO single-constant",
    "assertion can see it: every bound in that sum can be individually defensible while the",
    "stack is far past what a person waits before force-quitting (which restarts and pays",
    "all of it again). If a venue really should wait this long with the cached copy sitting",
    `on disk, raise ${ceilingName} in desktop/src/data/timeout-budgets.test.ts deliberately,`,
    "in the same commit, with the reason written down. Otherwise lower one of the bounds in",
    "the sum — the cheapest is usually a session probe, whose expiry costs nothing.",
  ].join(" ");

// ── the enumeration guard ─────────────────────────────────────────────────────
//
// A ceilings file that has to be remembered is a ceilings file that goes stale: the
// next module to grow a timeout gets a mechanism test (the shape of every other test
// in this directory makes that automatic) and no ceiling at all, which is the exact
// gap this file was written to close. So the constants are DISCOVERED from source
// rather than listed, and an exported wait-bound with no ceiling fails here.
//
// Discovery is BY NAME (BOUND_WORDS below), which is the guard's one soft edge: a
// bound named after none of those words is not seen. That is stated in the failure
// message too, because a reader here should not have to infer it.
//
// Non-vacuous by construction: a walk that found nothing (a moved directory, a
// regex that stopped matching) does not pass quietly — every row in BUDGETS is then
// reported as stale, because the two checks below are run in both directions.

// `fileURLToPath(import.meta.url)`, not `new URL(".", import.meta.url)`: under jsdom
// the global URL is jsdom's, and node:url refuses the resulting object with a
// "must be of scheme file" that points at this line and explains nothing.
const DATA_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_SRC = join(DATA_DIR, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The words a bound on waiting is plausibly NAMED after.
 *
 *  Discovery is by name, so the list is the guard's real coverage — and it used to be
 *  the single word TIMEOUT, while every line of prose in this file calls these numbers
 *  BUDGETS. A next bound named EVENT_BUNDLE_BUDGET_MS is not a contrived rename; it is
 *  the name this file teaches. It would have been invisible, gained a mechanism test
 *  like every other constant in the directory, and had no ceiling — the exact gap this
 *  file exists to close, reopened by a word.
 *
 *  A bound named after NONE of these is still invisible; that is the residual hole and
 *  it is named in the failure message rather than papered over. Widening the list is a
 *  one-word edit here. */
const BOUND_WORDS = ["TIMEOUT", "BUDGET", "DEADLINE", "GRACE", "WAIT"] as const;

/** Every `export const …<one of BOUND_WORDS>…` under desktop/src, mapped to its file.
 *
 *  EXPORTED only, on purpose. A module-private timeout (mgmt-outbox's audio upload
 *  bound) cannot be imported by a test at all, so no assertion here or anywhere else
 *  could reach it — and it answers a different question: a multi-megabyte push over a
 *  slow hotspot legitimately takes minutes, and there is nothing on disk to serve
 *  instead of waiting. If one is ever exported, this guard will demand a ceiling for
 *  it; the honest ceiling for an upload is minutes, and it belongs in its own kind. */
function exportedBounds(): Map<string, string> {
  const pattern = String.raw`^\s*export const ([A-Za-z0-9_]*(?:${BOUND_WORDS.join(
    "|"
  )})[A-Za-z0-9_]*)\s*=`;
  const found = new Map<string, string>();
  for (const file of sourceFiles(DESKTOP_SRC)) {
    const text = readFileSync(file, "utf8");
    // A fresh RegExp per file: matchAll on a shared /g literal is safe by spec, but a
    // local one removes the question entirely.
    for (const m of text.matchAll(new RegExp(pattern, "gm"))) {
      found.set(m[1], relative(DESKTOP_SRC, file).replace(/\\/g, "/"));
    }
  }
  return found;
}

// ── assertions ────────────────────────────────────────────────────────────────

describe("desktop timeout budgets", () => {
  it("gives every exported wait-bound in desktop/src an argued ceiling", () => {
    const found = exportedBounds();
    const covered = new Set(BUDGETS.map((b) => b.name));

    const missing = [...found]
      .filter(([name]) => !covered.has(name))
      .map(([name, file]) => `${name} (desktop/src/${file})`);
    expect(
      missing,
      `These wait-bounds are exported by desktop source and have no ceiling here: ` +
        `${missing.join(", ")}. A mechanism test for them proves only that the bound is ` +
        `WIRED UP — it advances the constant itself, so it stays green at any value, ` +
        `including ten minutes on a show screen. Add a row to BUDGETS in ` +
        `desktop/src/data/timeout-budgets.test.ts naming the human budget the number ` +
        `serves, and add it to a path total if it stacks with the others on one screen. ` +
        `⚠️ This guard finds bounds BY NAME — it only sees an exported const whose name ` +
        `contains one of ${BOUND_WORDS.join(", ")}. If you add a bound on how long an ` +
        `operator waits and call it something else, NOTHING here will ask you for a ` +
        `ceiling: add the word to BOUND_WORDS in the same commit, or add the row by hand.`
    ).toEqual([]);

    const stale = BUDGETS.map((b) => b.name).filter((name) => !found.has(name));
    expect(
      stale,
      `These have a ceiling here but are no longer exported by any desktop source file: ` +
        `${stale.join(", ")}. The constant was renamed, moved or deleted — update or drop ` +
        `the row (and any path total it appears in) rather than leaving a ceiling that ` +
        `guards a number nothing reads.`
    ).toEqual([]);
  });

  describe("each bound stays inside the ceiling for its kind of wait", () => {
    it.each(BUDGETS)("$name", (b) => {
      expect(b.ms, ceilingFailure(b)).toBeLessThanOrEqual(b.ceilingMs);
    });
  });

  describe("and so do the totals a person actually waits through", () => {
    it("cold dashboard boot, every bound expiring", () => {
      expect(
        total(DASHBOARD_BOOT),
        totalFailure(
          "Cold dashboard boot",
          DASHBOARD_BOOT,
          "DASHBOARD_BOOT_CEILING_MS",
          DASHBOARD_BOOT_CEILING_MS
        )
      ).toBeLessThanOrEqual(DASHBOARD_BOOT_CEILING_MS);
    });

    it("opening one show, the event row answering and the batch not", () => {
      expect(
        total(EVENT_OPEN),
        totalFailure(
          "Opening one show",
          EVENT_OPEN,
          "EVENT_OPEN_CEILING_MS",
          EVENT_OPEN_CEILING_MS
        )
      ).toBeLessThanOrEqual(EVENT_OPEN_CEILING_MS);
    });

    it("the run-order builder, which stacks five bounds on one constant", () => {
      expect(
        total(RUN_ORDER_BUILD),
        totalFailure(
          "The run-order builder",
          RUN_ORDER_BUILD,
          "RUN_ORDER_BUILD_CEILING_MS",
          RUN_ORDER_BUILD_CEILING_MS
        )
      ).toBeLessThanOrEqual(RUN_ORDER_BUILD_CEILING_MS);
    });
  });
});
