import { describe, expect, it } from "vitest";
import {
  canWriteJournal,
  canModifyLog,
  membershipFromProbe,
  membershipFromRefusal,
  isRlsRefusal,
  writeFailureMessage,
} from "@/lib/practice-journal-gate";

// These tests PIN THE HELPERS — what the UI believes about practice_logs' RLS.
// They do not read the schema, so a migration can never make them fail; that is
// worth stating plainly because the first version of this header promised the
// opposite ("if one of them fails after a migration, the migration changed the
// boundary"), and a docblock in the file under test was already one migration
// stale (0038 §P5) while these tests sat green. When a migration moves the
// boundary, the person who writes it has to come here and move these by hand.
// What the tests DO catch is the UI drifting away from what is written down, and
// the two halves of the practice room drifting away from each other.

describe("canWriteJournal — mirrors 0041 practice_logs_insert", () => {
  it("lets a band editor write (admin / this band's Ar), probe or no probe", () => {
    expect(canWriteJournal(true, "in-band")).toBe(true);
    expect(canWriteJournal(true, "outsider")).toBe(true);
    expect(canWriteJournal(true, "unknown")).toBe(true);
  });

  it("lets a plain member of the band write", () => {
    expect(canWriteJournal(false, "in-band")).toBe(true);
  });

  it("REFUSES a label-wide observer with no role in the band — the CEO case 0041 closed", () => {
    expect(canWriteJournal(false, "outsider")).toBe(false);
  });

  it("fails OPEN while the membership answer is unknown", () => {
    // in flight, offline, or an unsigned read: a member at a venue must not be
    // locked out of their own journal. RLS is still the real boundary.
    expect(canWriteJournal(false, "unknown")).toBe(true);
  });
});

describe("canModifyLog — mirrors 0024 practice_logs_update/_delete", () => {
  it("lets the author tick or delete their own row", () => {
    expect(canModifyLog(false, true)).toBe(true);
  });

  it("lets a band editor tick or delete anyone's row", () => {
    expect(canModifyLog(true, false)).toBe(true);
  });

  it("refuses a non-author non-editor — including a member of the same band", () => {
    // band membership is NOT part of the update/delete clause, so being in the
    // band does not earn the right to tick someone else's homework
    expect(canModifyLog(false, false)).toBe(false);
  });
});

describe("membershipFromProbe — an empty read is not an empty table", () => {
  it("treats a failed read as unknown, never as 'not a member'", () => {
    expect(membershipFromProbe(null, true)).toBe("unknown");
    expect(membershipFromProbe(null, false)).toBe("unknown");
  });

  it("treats rows as membership", () => {
    expect(membershipFromProbe(1, true)).toBe("in-band");
    expect(membershipFromProbe(2, true)).toBe("in-band");
  });

  it("believes an empty answer only when the request went out signed", () => {
    expect(membershipFromProbe(0, true)).toBe("outsider");
  });

  it("treats an empty answer from an unsigned (anon-fallback) request as unknown", () => {
    // supabase-js silently falls back to the anon key for ~a minute after a
    // failed token refresh, and RLS answers anon with [] and error null
    expect(membershipFromProbe(0, false)).toBe("unknown");
    expect(canWriteJournal(false, membershipFromProbe(0, false))).toBe(true);
  });

  it("gives the PLAYER half and the JOURNAL half the same answer — they run the same probe", () => {
    // The defect this pins: practice-mode.tsx ended its (identical) group_roles
    // probe with `setInThisBand(data.length > 0)` while practice-journal.tsx went
    // through membershipFromProbe. On an anon-fallback empty read that is `false`
    // vs `unknown` — a member of the band lost the add-song / reorder / marker
    // controls in the เครื่องเล่น tab and kept their composer in สมุดซ้อม, in the
    // same second, on the same screen. Both halves must land on the same boolean
    // for every probe outcome, so both call these functions now.
    // practice-mode.tsx's old body, kept here as the thing that must stay dead:
    // `if (error || !data) return; setInThisBand(data.length > 0)`
    const oldPlayerRule = (rows: number | null) => (rows ?? 0) > 0;
    const gate = (rows: number | null, signedIn: boolean) =>
      canWriteJournal(false, membershipFromProbe(rows, signedIn));

    // the two cases where the old rule LOCKED OUT a real member
    expect(gate(0, false)).toBe(true); // empty answer from an anon-fallback read
    expect(oldPlayerRule(0)).toBe(false);
    expect(gate(null, false)).toBe(true); // read failed outright
    expect(oldPlayerRule(null)).toBe(false);

    // and the cases both get right, so the fix didn't hand anyone new write access
    expect(gate(0, true)).toBe(false); // signed + empty = genuinely an outsider
    expect(gate(1, true)).toBe(true);
  });
});

describe("isRlsRefusal — the fail-open path's only way back", () => {
  // canWriteJournal deliberately fails open on `unknown`, so an outsider whose
  // membership probe blipped still gets the composer and still gets refused by
  // 0041 on บันทึก. Before this, addLog printed `error.message` — i.e. `new row
  // violates row-level security policy for table "practice_logs"`, English policy
  // text inside a Thai toast, which is THE bug this whole file was created to
  // remove — and nothing wrote the answer back, so the probe being one-shot meant
  // the person could retype and re-fail for the rest of the mount.
  it("recognises the policy refusal by code and by message", () => {
    expect(isRlsRefusal("42501", null)).toBe(true);
    expect(
      isRlsRefusal(null, 'new row violates row-level security policy for table "practice_logs"')
    ).toBe(true);
  });

  it("does not swallow other failures — those keep the generic toast", () => {
    expect(isRlsRefusal("23505", "duplicate key value violates unique constraint")).toBe(false);
    expect(isRlsRefusal(null, null)).toBe(false);
    expect(isRlsRefusal(undefined, undefined)).toBe(false);
    expect(isRlsRefusal("PGRST301", "JWT expired")).toBe(false);
  });

  it("the refusal resolves the gate: composer collapses instead of refusing forever", () => {
    // what addLog does with it — a refusal is a membership answer, and a better
    // one than the probe, because the policy answered in person
    expect(canWriteJournal(false, "unknown")).toBe(true); // before บันทึก
    expect(canWriteJournal(false, "outsider")).toBe(false); // after the refusal
  });
});

describe("membershipFromRefusal — an RLS refusal in the anon-fallback window proves nothing", () => {
  it("believes a refusal that went out signed", () => {
    expect(membershipFromRefusal(true, true)).toBe("outsider");
  });

  it("REFUSES to read an unsigned refusal as non-membership — the incident", () => {
    // `anon` holds no privileges on practice_logs (0026 grants only to
    // `authenticated`), so every insert in the anon-fallback minute comes back
    // 42501. The first cut believed it and told a real member of the band that
    // only Ar/เมมเบอร์ may write.
    expect(membershipFromRefusal(true, false)).toBe(null);
  });

  it("says nothing at all about a failure that was not a refusal", () => {
    expect(membershipFromRefusal(false, true)).toBe(null);
    expect(membershipFromRefusal(false, false)).toBe(null);
  });

  it("agrees with membershipFromProbe: neither turns an unsigned answer into 'outsider'", () => {
    // the asymmetry this helper exists to close — same hostile-looking answer,
    // same window, and before the fix the two paths disagreed
    expect(membershipFromProbe(0, false)).toBe("unknown");
    expect(membershipFromRefusal(true, false)).toBe(null);
  });

  it("leaves a known member's composer standing through the whole window", () => {
    // addLog's real shape: `const v = membershipFromRefusal(...); if (v) setMembership(v)`.
    // null must mean the previous verdict survives — that verdict is the only
    // thing keeping the composer, and the note they typed, on screen.
    const apply = (prev: "unknown" | "in-band" | "outsider", refused: boolean, signedIn: boolean) =>
      membershipFromRefusal(refused, signedIn) ?? prev;

    expect(canWriteJournal(false, apply("in-band", true, false))).toBe(true);
    expect(canWriteJournal(false, apply("unknown", true, false))).toBe(true);
    // and the genuine outsider still loses it, so nothing was handed back
    expect(canWriteJournal(false, apply("unknown", true, true))).toBe(false);
  });
});

describe("writeFailureMessage — no English policy text reaches a Thai screen", () => {
  const RLS_TEXT = 'new row violates row-level security policy for table "practice_logs"';
  const GRANT_TEXT = "permission denied for table practice_logs";

  it("never returns any part of the PostgREST message", () => {
    // the original bug, on all three shapes that can carry it
    for (const [code, message] of [
      ["42501", GRANT_TEXT],
      [null, RLS_TEXT],
      [null, "TypeError: Failed to fetch"],
    ] as const) {
      const out = writeFailureMessage(code, message, true);
      expect(out).not.toContain("permission denied");
      expect(out).not.toContain("row-level security");
      expect(out).not.toContain("Failed to fetch");
      expect(out).toMatch(/[฀-๿]/); // Thai
    }
  });

  it("calls an UNSIGNED refusal a session problem, not a permission problem", () => {
    // the member ticking their own homework in the anon-fallback minute: telling
    // them they lack permission is both wrong and unactionable
    const out = writeFailureMessage("42501", GRANT_TEXT, false);
    expect(out).toContain("เซสชันหมดอายุ");
    expect(out).not.toContain("ไม่มีสิทธิ์");
  });

  it("calls a SIGNED refusal a permission problem", () => {
    const out = writeFailureMessage("42501", GRANT_TEXT, true);
    expect(out).toContain("ไม่มีสิทธิ์");
    expect(out).not.toContain("เซสชันหมดอายุ");
  });

  it("does not send an OFFLINE user to the login screen", () => {
    // the desktop at a venue with no signal: the token expired and the refresh
    // could not reach Supabase, so signedIn is false for a write that never left
    // the device. "เข้าสู่ระบบใหม่" there wipes the queued offline edits
    // (SIGNED_OUT → clearMgmtOutbox) and they cannot log back in with no network.
    const out = writeFailureMessage(null, "TypeError: Failed to fetch", false);
    expect(out).not.toContain("เซสชันหมดอายุ");
    expect(out).toContain("เน็ตหลุด");
  });

  it("does not blame permissions for an ordinary failure", () => {
    const out = writeFailureMessage(null, "TypeError: Failed to fetch", true);
    expect(out).not.toContain("ไม่มีสิทธิ์");
    expect(out).not.toContain("เซสชันหมดอายุ");
  });
});
