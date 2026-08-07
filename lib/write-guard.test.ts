// "A write that reported no error but touched no row did not happen."
//
// The twin of the empty-read rule, and the more expensive one: a failed read shows
// nothing and the user retries, while a failed write shows a green toast and the
// truth surfaces at the venue. In one case the app went further and deleted the
// queued offline copy on the strength of the fake success. Both halves of the cure
// are here — the predicate that spots it, and the message that tells the operator
// which of the only two possible causes it was.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSupabaseFake, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { noRowsMessage, wroteNothing } from "@/lib/write-guard";

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake();
  h.supa = supa;
});

describe("wroteNothing", () => {
  // The 204/error:null anon reply, exactly as PostgREST sends it back through
  // `.update(...).select("id")`.
  it("an empty array is a write that landed on nothing", () => {
    expect(wroteNothing([])).toBe(true);
  });

  it("any returned row means the write landed", () => {
    expect(wroteNothing([{ id: "e1" }])).toBe(false);
    expect(wroteNothing([{ id: "e1" }, { id: "e2" }])).toBe(false);
  });

  // A `null` data comes with an error, and the caller's error branch owns that case.
  // Reporting it here as well would send the operator the wrong message: "your
  // session expired" instead of "the network failed".
  it("null and undefined are the errored call, not this case", () => {
    expect(wroteNothing(null)).toBe(false);
    expect(wroteNothing(undefined)).toBe(false);
  });

  // `.maybeSingle()` after a write resolves to a row OBJECT (or null), never to [].
  // The guard must not read that object as a no-op write.
  it("a single-row shape is not an empty array", () => {
    expect(wroteNothing({ id: "e1" } as unknown as unknown[])).toBe(false);
  });
});

describe("noRowsMessage", () => {
  // Only two causes are possible once the request demonstrably reached the server,
  // and they need opposite actions from the operator — so the branch is the point,
  // and the assertion anchors on the ACTION each message asks for rather than on
  // the whole sentence, which is copy.
  it("with a live session it is a permissions / deleted-row problem: reload and retry", async () => {
    supa.auth.setSession(makeSession());
    const msg = await noRowsMessage();
    expect(msg).toContain("โหลดหน้าใหม่");
    expect(msg).not.toContain("เข้าสู่ระบบใหม่");
  });

  it("with no session it is the anon fallback: sign in again and save again", async () => {
    supa.auth.setSession(null);
    const msg = await noRowsMessage();
    expect(msg).toContain("เข้าสู่ระบบใหม่");
    expect(msg).not.toContain("โหลดหน้าใหม่");
  });

  it("the two causes never produce the same sentence", async () => {
    supa.auth.setSession(makeSession());
    const live = await noRowsMessage();
    supa.auth.setSession(null);
    expect(await noRowsMessage()).not.toBe(live);
  });

  // Fail toward the recoverable instruction: if we cannot tell whether we still
  // hold a session, "sign in again and save again" costs the operator a login and
  // keeps the edit, while "reload the page" throws the unsaved edit away.
  it("an unanswerable session check falls back to the sign-in-again message", async () => {
    supa.auth.getSession.mockRejectedValueOnce(new Error("storage is not available"));
    expect(await noRowsMessage()).toContain("เข้าสู่ระบบใหม่");
  });
});
