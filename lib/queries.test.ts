import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eventBundleReadFailure, getWorkspace, isEventIdShaped } from "@/lib/queries";
import {
  makeSupabaseFake,
  makeSession,
  ok,
  fail,
  type SupabaseFake,
} from "@/test/fakes/supabase";

// getWorkspace() reaches the DB through the SERVER client (cookies + RSC). One
// top-of-file mock of that specifier is the whole seam; the factory is hoisted
// above every binding in this file, so it may only reach through the hoisted box.
const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.supa }));

// Round 10: getEventBundle used to write `schedule.data ?? []` for six parallel
// child reads and never inspect `.error`. postgrest-js resolves a 500 / 429 /
// statement timeout as `{ data: null, error }` — it does not throw — so `?? []`
// turned a FAILED read into a genuine empty list, and the event page rendered a
// real show as having no setlist. Staff who then pressed กู้คืน got the saved
// version inserted while the "replace the current rows" delete was skipped
// (it is gated on `old.length`), leaving the band with a duplicated setlist that
// the run sheet printed and Live Mode ran.
//
// These tests pin the one decision that prevents it: an errored read is a
// failure, an empty-but-successful read is not.
describe("eventBundleReadFailure", () => {
  const ok = { error: null };

  it("returns null when every read succeeded", () => {
    expect(
      eventBundleReadFailure("ev-1", {
        schedule: ok,
        setlist: ok,
        micMap: ok,
        members: ok,
        songs: ok,
        lineup: ok,
      })
    ).toBeNull();
  });

  it("treats a genuinely EMPTY successful read as success, not failure", () => {
    // The whole point: a brand-new show really does have no setlist yet, and that
    // must stay indistinguishable from... nothing. Only `.error` decides.
    expect(eventBundleReadFailure("ev-1", { setlist: { error: null } })).toBeNull();
  });

  it("reports a single failed child read, in Thai, naming the part", () => {
    const err = eventBundleReadFailure("ev-1", {
      schedule: ok,
      setlist: { error: { message: "canceling statement due to statement timeout" } },
      micMap: ok,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err!.name).toBe("EventBundleReadError");
    expect(err!.message).toContain("อ่านข้อมูลงานไม่สำเร็จ");
    expect(err!.message).toContain("เซ็ตลิสต์");
    // The cause must survive into the server log, where the digest is matched to it.
    expect(err!.message).toContain("statement timeout");
    expect(err!.message).toContain("ev-1");
    // A read that did NOT fail must not be named as if it had.
    expect(err!.message).not.toContain("รันดาวน์");
  });

  it("names every failed read when several fail at once", () => {
    const err = eventBundleReadFailure("ev-2", {
      setlist: { error: { message: "503" } },
      members: { error: { message: "503" } },
      songs: ok,
    });
    expect(err!.message).toContain("เซ็ตลิสต์");
    expect(err!.message).toContain("สมาชิกวง");
    expect(err!.message).not.toContain("คลังเพลง");
  });

  it("fails the whole bundle when the EVENT read itself errors", () => {
    // The second half of the finding: an errored parent read used to land in
    // `if (!event) return null` → notFound() → "ไม่พบงานนี้" for a show that is
    // perfectly fine. "Could not be read" is not "does not exist".
    const err = eventBundleReadFailure("ev-3", {
      event: { error: { message: "fetch failed" } },
    });
    expect(err).not.toBeNull();
    expect(err!.message).toContain("ข้อมูลงาน");
  });

  it("still fails loudly when the driver gives no message text", () => {
    const err = eventBundleReadFailure("ev-4", { micMap: { error: {} } });
    expect(err).not.toBeNull();
    expect(err!.message).toContain("ผังไมค์");
    expect(err!.message).toContain("unknown error");
  });
});

// Round 11: the guard above shipped without this check and made things worse for
// the commonest bad URL there is. `events.id` is `uuid`, so PostgREST answers
// `?id=eq.garbage` with 400 `22P02 invalid input syntax for type uuid` — a
// POPULATED `.error`, which eventBundleReadFailure (correctly, for its own job)
// calls a failed read. Result: a link truncated on its way through LINE, a
// `/events/undefined` bookmark, or any authenticated crawler got the red
// "หน้านี้มีปัญหา" card plus a console.error per hit, instead of the Thai 404 that
// app/(app)/not-found.tsx exists to serve. "That is not an id" is a NOT-FOUND.
//
// These tests pin the shape rule so nobody widens it into something that lets
// garbage reach the query again, and nobody narrows it so far that a real id 404s.
describe("isEventIdShaped", () => {
  it("accepts a real gen_random_uuid() id, in either case", () => {
    expect(isEventIdShaped("9f3a1c8e-2b4d-4a91-8c7e-1f2a3b4c5d6e")).toBe(true);
    expect(isEventIdShaped("9F3A1C8E-2B4D-4A91-8C7E-1F2A3B4C5D6E")).toBe(true);
  });

  it("rejects the truncated-link case that caused the crash page", () => {
    // The exact incident: the last two characters were lost in a paste.
    expect(isEventIdShaped("9f3a1c8e-2b4d-4a91-8c7e-1f2a3b4c5d")).toBe(false);
  });

  it("rejects the other real-world junk ids", () => {
    for (const junk of ["", "1", "undefined", "null", "new", "  ", "not-a-uuid"]) {
      expect(isEventIdShaped(junk)).toBe(false);
    }
  });

  it("rejects lookalikes that would still reach the DB as garbage", () => {
    // Non-hex letters, no hyphens, braced, and trailing whitespace/slop — Postgres
    // accepts some of these as uuid text, but nothing in CueIQ ever produces them,
    // and 404 is the right answer for all of them.
    expect(isEventIdShaped("9f3a1c8e-2b4d-4a91-8c7e-1f2a3b4c5d6z")).toBe(false);
    expect(isEventIdShaped("9f3a1c8e2b4d4a918c7e1f2a3b4c5d6e")).toBe(false);
    expect(isEventIdShaped("{9f3a1c8e-2b4d-4a91-8c7e-1f2a3b4c5d6e}")).toBe(false);
    expect(isEventIdShaped("9f3a1c8e-2b4d-4a91-8c7e-1f2a3b4c5d6e ")).toBe(false);
    expect(isEventIdShaped("9f3a1c8e-2b4d-4a91-8c7e-1f2a3b4c5d6e/edit")).toBe(false);
  });

  it("is not fooled by a newline (the regex must be anchored, not multiline)", () => {
    // `$` in a non-multiline regex still matches before a trailing \n in some
    // engines' \n handling; JS's `$` does not, but pin it — a smuggled newline is
    // how an injected second line would ride along into a query string.
    expect(isEventIdShaped("9f3a1c8e-2b4d-4a91-8c7e-1f2a3b4c5d6e\nx")).toBe(false);
    expect(isEventIdShaped("\n9f3a1c8e-2b4d-4a91-8c7e-1f2a3b4c5d6e")).toBe(false);
  });
});

// Round 12: lib/read-guard.ts was wired into four server pages so that a failed
// read stops becoming a confident wrong number — and getWorkspace(), which runs
// FIRST on all four of them (the (app) layout awaits it before anything renders),
// discarded `.error` on all four of its OWN reads. These failures are sharper than
// the counts that were fixed, because each one comes out as a PERMISSION ANSWER:
//
//   tenant_members / tenants fail → membership/tenant null → /overview and
//     /dashboard render <JoinDemo/> ("บัญชียังไม่ได้รับสิทธิ์เข้าวง") at a real label
//     member, and both /events/[id]/run-order routes silently bounce to /dashboard —
//     the route ~19 phones open within seconds when staff press เริ่ม;
//   group_roles fails → groupRoles [] → canViewGroup false → an Ar is locked out of
//     their own band's show;
//   groups fails → [] is fed back in as `.in("group_id", …)`, so the events read
//     returns zero rows while SUCCEEDING and the page's own guard confirms all is
//     well.
//
// One case per read, plus the two that must NOT throw.
describe("getWorkspace", () => {
  const USER_ID = "11111111-1111-4111-8111-111111111111";
  const TID = "22222222-2222-4222-8222-222222222222";
  const GID = "33333333-3333-4333-8333-333333333333";

  /** Every read healthy — override one entry per test to break exactly one. */
  const healthy = () => ({
    tenant_members: ok([{ tenant_id: TID, role: "member" }]),
    group_roles: ok([{ group_id: GID, role: "artist_manager" }]),
    tenants: ok([{ id: TID, name: "A Lot Of Tone" }]),
    groups: ok([{ id: GID, name: "Seishin Kakumei", tenant_id: TID }]),
  });

  let supa: SupabaseFake;
  let logged: string[];

  beforeEach(() => {
    supa = makeSupabaseFake({
      session: makeSession({ user: { id: USER_ID, email: "seishin-ar@cueiq.local" } }),
      script: healthy(),
    });
    h.supa = supa;
    // assertReadsSucceeded logs the cause before throwing — that console line is the
    // only thing tying the card the user sees to a cause in the Vercel log, so keep
    // it out of the test output but assert it happened.
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the whole workspace when every read succeeds (positive control)", async () => {
    const ws = await getWorkspace();

    expect(ws.user?.id).toBe(USER_ID);
    expect(ws.membership).toEqual({ tenant_id: TID, role: "member" });
    expect(ws.tenant?.name).toBe("A Lot Of Tone");
    expect(ws.groups.map((g) => g.id)).toEqual([GID]);
    expect(ws.groupRoles).toEqual([{ group_id: GID, role: "artist_manager" }]);
    expect(ws.perms).toEqual({
      tenantRole: "member",
      groupRoles: [{ group_id: GID, role: "artist_manager" }],
    });
    expect(logged).toEqual([]);
  });

  it("THROWS when the tenant_members read fails, instead of answering 'not a member'", async () => {
    supa.setTable("tenant_members", fail("canceling statement due to statement timeout"));

    await expect(getWorkspace()).rejects.toThrow("อ่านข้อมูลไม่สำเร็จ");
    await expect(getWorkspace()).rejects.toMatchObject({ name: "ReadFailedError" });
    // The cause has to reach the server log: Next redacts the message in production
    // and the client only ever sees a digest.
    expect(logged.join("\n")).toContain("getWorkspace read failed");
    expect(logged.join("\n")).toContain("statement timeout");
  });

  it("does not go on to read tenants/groups once identity is unknown", async () => {
    // Not tidiness: reaching the second batch with `memberRow.tenant_id` undefined
    // would send `?id=eq.undefined` at Postgres and answer with a DIFFERENT error
    // about a different table, which is what the next reader would then chase.
    supa.setTable("tenant_members", fail("503"));

    await expect(getWorkspace()).rejects.toThrow();
    expect(supa.callsTo("tenants")).toHaveLength(0);
    expect(supa.callsTo("groups")).toHaveLength(0);
  });

  it("THROWS when the group_roles read fails, instead of locking an Ar out of their band", async () => {
    supa.setTable("group_roles", fail("canceling statement due to statement timeout"));

    await expect(getWorkspace()).rejects.toThrow("บทบาทในวง");
  });

  it("THROWS when the tenants read fails, instead of showing the join screen", async () => {
    supa.setTable("tenants", fail("fetch failed"));

    await expect(getWorkspace()).rejects.toThrow("ข้อมูลค่าย");
  });

  it("THROWS when the groups read fails, instead of a label with no bands", async () => {
    // The quiet one: `groups: []` is fed back into the next page's query as
    // `.in("group_id", [])`, so the events read returns nothing AND succeeds.
    supa.setTable("groups", fail("canceling statement due to statement timeout"));

    await expect(getWorkspace()).rejects.toThrow("รายชื่อวง");
  });

  it("names ONLY the read that failed", async () => {
    supa.setTable("groups", fail("503"));

    const err = await getWorkspace().catch((e: Error) => e);
    expect((err as Error).message).toContain("รายชื่อวง");
    expect((err as Error).message).not.toContain("ข้อมูลค่าย");
  });

  it("still shows a brand-new account the join screen (empty is not failure)", async () => {
    // The invariant the guards must not break: maybeSingle() reports "no such row"
    // as { data: null, error: null }, and that is a real answer about a real account.
    supa.setTable("tenant_members", ok([]));

    const ws = await getWorkspace();
    expect(ws.user?.id).toBe(USER_ID);
    expect(ws.membership).toBeNull();
    expect(ws.tenant).toBeNull();
    expect(ws.perms.tenantRole).toBeNull();
    expect(logged).toEqual([]);
  });

  it("keeps the join screen even if group_roles errored, when there is no membership", async () => {
    // The one degrade: on this path the group_roles answer is DISCARDED — groupRoles
    // is [] and perms is makePerms(null) whatever it said — so failing over it would
    // turn a first-login hiccup into an error card on the one screen whose whole job
    // is to say "ask an admin to add you".
    supa.setTable("tenant_members", ok([]));
    supa.setTable("group_roles", fail("503"));

    const ws = await getWorkspace();
    expect(ws.membership).toBeNull();
    expect(ws.groupRoles).toEqual([]);
  });

  it("accepts empty-but-successful group and role lists for a real member", async () => {
    // A label with no bands yet, and a member with no per-band row: both are real
    // answers and must render, not throw.
    supa.setTable("group_roles", ok([]));
    supa.setTable("groups", ok([]));

    const ws = await getWorkspace();
    expect(ws.membership).toEqual({ tenant_id: TID, role: "member" });
    expect(ws.groups).toEqual([]);
    expect(ws.groupRoles).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("returns the signed-out shape without reading anything", async () => {
    supa.auth.setSession(null);

    const ws = await getWorkspace();
    expect(ws.user).toBeNull();
    expect(ws.membership).toBeNull();
    expect(supa.calls).toHaveLength(0);
  });
});
