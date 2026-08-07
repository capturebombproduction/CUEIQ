import { describe, it, expect } from "vitest";
import { eventBundleReadFailure, isEventIdShaped } from "@/lib/queries";

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
