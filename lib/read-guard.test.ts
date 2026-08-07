import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFailure, assertReadsSucceeded, keepOnUntrustedEmpty } from "@/lib/read-guard";
import { makeSupabaseFake, makeSession, type SupabaseFake } from "@/test/fakes/supabase";

// keepOnUntrustedEmpty asks lib/auth-session, which asks the browser client. One
// top-of-file mock of the SPECIFIER covers it; the factory is hoisted above every
// binding in this file, so it may only reach through the hoisted box.
const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
});

// A FAILED READ IS NOT A ZERO COUNT.
//
// Round 12: /overview's readPaged is carefully written to hand back
// `{ data: null, error }` — and then all eight consumers wrote `res.data ?? []`
// and never looked at `.error`. Each of those `?? []` turns "we could not find
// out" into a confident number: a complete show displaying "⚠ ขาด N", an
// unreviewed song counted as cleared, and — the sharp one — an emptied
// runOrderFestivals, which removes the "คุมคิว (Live)" entry from the date header
// and takes staff's way into the live show-caller with it, mid-festival.
//
// These tests pin the one decision that prevents all four: an errored read is a
// failure, an empty-but-successful read is not.
describe("readFailure", () => {
  const ok = { error: null };

  it("returns null when every read succeeded", () => {
    expect(readFailure({ a: ok, b: ok, c: ok })).toBeNull();
  });

  it("treats a genuinely EMPTY successful read as success, not failure", () => {
    // The guard rail on the fix itself. A brand-new festival really has no
    // running order, a new band really has no songs — and the cure for "throws
    // nothing when it should" must never become "throws on every empty state".
    // Only `.error` decides; the rows are not even passed in.
    expect(readFailure({ runOrder: { error: null } })).toBeNull();
    expect(readFailure({})).toBeNull();
  });

  it("names the failed part and carries its cause into the message", () => {
    const err = readFailure(
      {
        events: ok,
        setlist: { error: { message: "canceling statement due to statement timeout" } },
        songs: ok,
      },
      "OverviewPage"
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.name).toBe("ReadFailedError");
    expect(err!.message).toContain("setlist");
    // The cause has to survive into the server log — it is all the digest has.
    expect(err!.message).toContain("statement timeout");
    expect(err!.message).toContain("OverviewPage");
    // A read that did NOT fail must not be named as if it had.
    expect(err!.message).not.toContain("songs");
  });

  it("names EVERY failed read when several fail at once", () => {
    const err = readFailure({
      setlist: { error: { message: "503" } },
      micMap: { error: { message: "503" } },
      songs: ok,
    });
    expect(err!.message).toContain("setlist");
    expect(err!.message).toContain("micMap");
    expect(err!.message).not.toContain("songs");
  });

  it("is ALL OR NONE — one bad read fails the set", () => {
    const many: Record<string, { error: { message: string } | null }> = {};
    for (let i = 0; i < 7; i++) many[`read${i}`] = { error: null };
    expect(readFailure(many)).toBeNull();
    many.read4 = { error: { message: "boom" } };
    expect(readFailure(many)).not.toBeNull();
  });

  it("still fails loudly when the driver gives no message text", () => {
    // A fetch abort can arrive as an error object with nothing readable on it.
    // "unknown error" is still infinitely better than a silent zero.
    const err = readFailure({ micMap: { error: {} } });
    expect(err).not.toBeNull();
    expect(err!.message).toContain("micMap");
    expect(err!.message).toContain("unknown error");
  });

  it("treats a read that was never attempted as neither success nor failure", () => {
    // `ids.length ? await supabase… : { data: [], error: null }` and friends: a
    // skipped read has nothing to report, and must not be invented as a failure.
    expect(readFailure({ stages: undefined, seqs: null })).toBeNull();
  });
});

describe("assertReadsSucceeded", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns quietly when every read succeeded", () => {
    expect(() => assertReadsSucceeded("SomePage", { a: { error: null } })).not.toThrow();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("throws the named error AND logs the cause for the digest", () => {
    // Next redacts the message in production, so the ONLY place the cause can be
    // recovered is this console line, matched to the digest on the error card.
    expect(() =>
      assertReadsSucceeded("OverviewPage", { runOrder: { error: { message: "pooler down" } } })
    ).toThrow(/pooler down/);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain("OverviewPage");
  });
});

// The client-side half: an empty answer we cannot prove was signed.
describe("keepOnUntrustedEmpty", () => {
  it("believes an empty read while a live session is provable", async () => {
    expect(await keepOnUntrustedEmpty([], true)).toBe(false);
    expect(supa.auth.getSession).toHaveBeenCalled();
  });

  it("refuses an empty read taken without a usable token", async () => {
    // The venue reconnect: auth-js has cached a failed refresh, supabase-js signs
    // with the anon key, RLS answers [] with no error. Wiping the board on that
    // is what emptied a running festival's order.
    supa.auth.setSession(null);
    expect(await keepOnUntrustedEmpty([], true)).toBe(true);
  });

  it("accepts an empty answer when there is nothing to lose", async () => {
    // A board that is already empty pays no getSession() round trip — and a user
    // who genuinely owns nothing must still see the empty state.
    supa.auth.setSession(null);
    expect(await keepOnUntrustedEmpty([], false)).toBe(false);
    expect(supa.auth.getSession).not.toHaveBeenCalled();
  });

  it("never second-guesses a NON-empty read", async () => {
    supa.auth.setSession(null);
    expect(await keepOnUntrustedEmpty([{ id: "a" }], true)).toBe(false);
    expect(supa.auth.getSession).not.toHaveBeenCalled();
  });

  it("leaves an ERRORED read to the caller's error branch", async () => {
    // null data means the call failed — that is readFailure's job, not this one.
    // Same division of labour as write-guard's wroteNothing().
    supa.auth.setSession(null);
    expect(await keepOnUntrustedEmpty(null, true)).toBe(false);
    expect(await keepOnUntrustedEmpty(undefined, true)).toBe(false);
    expect(supa.auth.getSession).not.toHaveBeenCalled();
  });

  it("keeps the rows when asking auth THROWS", async () => {
    // hasLiveSession() swallows the throw and answers false, which lands here as
    // "keep what you have" — the safe direction when we cannot even ask.
    supa.auth.getSession.mockRejectedValueOnce(new Error("network"));
    expect(await keepOnUntrustedEmpty([], true)).toBe(true);
  });

  it("defaults hadRows to true — the cautious reading", async () => {
    // notification-bell's first load calls it with no baseline at all.
    supa.auth.setSession(null);
    expect(await keepOnUntrustedEmpty([])).toBe(true);
  });
});
