import { describe, expect, it } from "vitest";
import {
  type AuthorityRow,
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
  it("a fresh heartbeat is not a ghost", () => {
    expect(isGhost(row(new Date(now).toISOString()), now)).toBe(false);
    expect(isGhost(row(new Date(now - (GHOST_MS - 1000)).toISOString()), now)).toBe(false);
  });
  it("a heartbeat older than the ghost window is a ghost", () => {
    expect(isGhost(row(new Date(now - (GHOST_MS + 1000)).toISOString()), now)).toBe(true);
  });
  it("an unparseable heartbeat is treated as a ghost (never trust a broken claim)", () => {
    expect(isGhost(row("not-a-timestamp"), now)).toBe(true);
  });
  it("GHOST_MS is the documented 90s window", () => {
    expect(GHOST_MS).toBe(90_000);
  });
});
