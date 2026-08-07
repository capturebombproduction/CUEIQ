import { describe, expect, it } from "vitest";
import {
  type AuthorityRow,
  CLOCK_SKEW_GRACE_MS,
  GHOST_MS,
  canOverride,
  isGhost,
  rankOf,
} from "./show-authority";

const row = (heartbeat_at: string): AuthorityRow => ({
  event_id: "e1",
  kind: "show_main",
  device_id: "d1",
  device_label: null,
  by_user_id: null,
  by_role: null,
  claimed_at: heartbeat_at,
  heartbeat_at,
});

describe("rankOf — the break-glass ladder", () => {
  it("ranks roles member < Ar < label_staff < ceo < admin", () => {
    expect(rankOf("member")).toBe(0);
    expect(rankOf("artist_manager")).toBe(1);
    expect(rankOf("label_staff")).toBe(2);
    expect(rankOf("ceo")).toBe(3);
    expect(rankOf("admin")).toBe(4);
  });
  it("treats null / undefined / unknown roles as the lowest rank", () => {
    expect(rankOf(null)).toBe(0);
    expect(rankOf(undefined)).toBe(0);
    expect(rankOf("president")).toBe(0);
  });
});

describe("canOverride — only a STRICTLY higher rank may force-take a role", () => {
  it("a higher rank overrides a lower one", () => {
    expect(canOverride("member", "admin")).toBe(true);
    expect(canOverride("member", "artist_manager")).toBe(true);
    expect(canOverride("label_staff", "ceo")).toBe(true);
  });
  it("an equal or lower rank may not override (no peer steal)", () => {
    expect(canOverride("ceo", "ceo")).toBe(false);
    expect(canOverride("admin", "member")).toBe(false);
    expect(canOverride("artist_manager", "member")).toBe(false);
  });
  it("an unknown / missing holder is rank 0, so any real role outranks it — but a peer at 0 does not", () => {
    expect(canOverride(null, "admin")).toBe(true);
    expect(canOverride(null, "member")).toBe(false);
  });
});

describe("isGhost — a stale heartbeat is reclaimable", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  // Heartbeat stamped `ageMs` ago on OUR clock. Nothing measures the holder's
  // clock, so the window is always GHOST_MS + the grace.
  const aged = (ageMs: number) => row(new Date(now - ageMs).toISOString());

  it("a fresh heartbeat is not a ghost", () => {
    expect(isGhost(row(new Date(now).toISOString()), now)).toBe(false);
    expect(isGhost(aged(GHOST_MS - 1000), now)).toBe(false);
  });
  it("a heartbeat older than the ghost window PLUS the unmeasured-clock grace is a ghost", () => {
    expect(isGhost(aged(GHOST_MS + CLOCK_SKEW_GRACE_MS + 1000), now)).toBe(true);
  });
  it("an unparseable heartbeat is treated as a ghost (never trust a broken claim)", () => {
    expect(isGhost(row("not-a-timestamp"), now)).toBe(true);
  });
  it("GHOST_MS is the documented 90s window", () => {
    expect(GHOST_MS).toBe(90_000);
  });
  it("CLOCK_SKEW_GRACE_MS is the documented 2 minutes of unmeasured clock drift", () => {
    expect(CLOCK_SKEW_GRACE_MS).toBe(120_000);
  });
  // The number the whole product reasons about is the SUM, and round 10 changed it
  // while leaving otherDeviceHoldsShow()'s comment in live-mode.tsx quoting the old
  // 90s — where it stayed, wrong, through two review waves. That prose now quotes
  // the sum; pin the effective window here so the next person who touches either
  // term sees the real figure and moves the prose with it.
  it("the EFFECTIVE window every caller gets is 210s (3.5 นาที), not GHOST_MS", () => {
    expect(GHOST_MS + CLOCK_SKEW_GRACE_MS).toBe(210_000);
    expect(isGhost(aged(209_999), now)).toBe(false);
    expect(isGhost(aged(210_001), now)).toBe(true);
  });
});

// The round-10 finding: heartbeat_at is the HOLDER's wall clock, isGhost compares
// it against OURS, and 61 seconds of disagreement was enough to call a working PA
// dead. See the long note above isGhost in show-authority.ts.
//
// ⚠️ Round 10 first shipped this as a MEASURED correction — an exported
// clockSkewMs() and a third `skewMs` argument on isGhost — and no caller ever
// passed the argument, so half of what these tests covered was unreachable code.
// The measurement API was deleted; what ships is a flat grace, and these tests now
// exercise the only call shape that exists: isGhost(row, now).
describe("isGhost — clock skew between the holder and the observer", () => {
  const now = Date.parse("2026-06-25T21:15:00.000Z");
  const aged = (ageMs: number) => row(new Date(now - ageMs).toISOString());
  // The incident: a PA desktop off-network for days, clock 2 minutes slow, alive
  // and heartbeating every 30s. Its freshest heartbeat lands 120s + 0..30s in our
  // past purely because of the clock, never because it went quiet.
  const SLOW_PA_SKEW = 120_000;

  it("THE INCIDENT: a live PA whose clock is 2 minutes slow is no longer called dead", () => {
    expect(isGhost(aged(SLOW_PA_SKEW + 5_000), now)).toBe(false); // just heartbeat
    expect(isGhost(aged(SLOW_PA_SKEW + 29_000), now)).toBe(false); // mid-interval
  });

  it("a holder that REALLY goes quiet is still detected — the grace forgives the clock, not the silence", () => {
    // same 2-minute-slow desk, but its last heartbeat was 5 real minutes ago
    expect(isGhost(aged(SLOW_PA_SKEW + 300_000), now)).toBe(true);
  });

  it("the grace window applies to every call — there is no second, tighter path", () => {
    const edge = GHOST_MS + CLOCK_SKEW_GRACE_MS;
    expect(isGhost(aged(edge - 1), now)).toBe(false);
    expect(isGhost(aged(edge), now)).toBe(false); // strictly greater-than
    expect(isGhost(aged(edge + 1), now)).toBe(true);
  });

  // THE GUARD AGAINST DOING IT AGAIN. If someone re-introduces a per-peer skew
  // argument, the dangerous half is not that it goes unwired (that is only a
  // documentation bug) — it is that a wrongly-mapped measurement hands an
  // unmeasured holder a zero allowance and narrows its window back to 90s, which
  // is the incident above. Nothing a peer could hand us may make a holder INSIDE
  // the window into a ghost. This assertion is why the extra argument is cast in.
  it("no third argument can narrow the window — an unwired measurement must never punish", () => {
    const call = isGhost as unknown as (
      r: AuthorityRow,
      n: number,
      extra?: unknown
    ) => boolean;
    const insideWindow = aged(GHOST_MS + CLOCK_SKEW_GRACE_MS - 1);
    for (const extra of [undefined, null, NaN, Infinity, 0, -120_000, 120_000]) {
      expect(
        call(insideWindow, now, extra),
        `extra=${String(extra)} turned a live holder into a ghost`
      ).toBe(false);
    }
  });

  it("a holder whose clock is AHEAD puts its heartbeat in our future — never a ghost, as always", () => {
    expect(isGhost(row(new Date(now + 90_000).toISOString()), now)).toBe(false);
  });

  it("MONOTONICITY: nothing this function calls a ghost was a non-ghost under the old rule", () => {
    // Old rule, verbatim from before the grace was added: now - heartbeat_at > GHOST_MS.
    // The whole change is allowed to be forgiving and is never allowed to punish —
    // round 9's CRITICAL bug was a phone stealing control from the PA mid-song, and
    // a widened staleness window must not become a new way to do that.
    const wasGhostBefore = (ageMs: number) => ageMs > GHOST_MS;
    const ages = [
      -300_000, -1, 0, 1, 29_000, GHOST_MS - 1, GHOST_MS, GHOST_MS + 1, 100_000,
      GHOST_MS + CLOCK_SKEW_GRACE_MS, GHOST_MS + CLOCK_SKEW_GRACE_MS + 1, 600_000,
      86_400_000,
    ];
    for (const ageMs of ages) {
      if (isGhost(aged(ageMs), now)) {
        expect(
          wasGhostBefore(ageMs),
          `age=${ageMs} became a ghost that the old rule spared`
        ).toBe(true);
      }
    }
  });
});
