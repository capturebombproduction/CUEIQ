import { describe, expect, it } from "vitest";
import { FEEDBACK_IMAGE_FILE, isPresignOp, planPresign } from "@/lib/presign-authz";
import { FEEDBACK_IMAGE_EXTS, buildFeedbackImagePath } from "@/lib/audio-remote";

// Nothing had ever tested the one door to the R2 bucket. These are the rules the
// route now executes verbatim.

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const BAND = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const SOMEONE_ELSE = "44444444-4444-4444-8444-444444444444";

const feedbackKey = (tenant: string, author: string, file = "abcd1234abcd1234.png") =>
  `${tenant}/feedback/${author}/${file}`;

describe("planPresign · the shapes that are not keys at all", () => {
  it("refuses a leading slash, a traversal, and an unknown op", () => {
    expect(planPresign(`/${TENANT}/x/y/z.png`, "get", ME).decision).toBe("bad-key");
    expect(planPresign(`${TENANT}/../secrets`, "get", ME).decision).toBe("bad-key");
    expect(planPresign(`${TENANT}/${BAND}/e/i.wav`, "list", ME).decision).toBe("bad-key");
    expect(planPresign("", "get", ME).decision).toBe("bad-key");
  });

  it("refuses the backups/ prefix, which is the nightly DB snapshot", () => {
    // "backups" is not a UUID, so it can never reach a signing branch. The whole
    // DB in one file is behind an admin-gated download route, not behind this one.
    expect(planPresign("backups/2026-08-31.json", "get", ME).decision).toBe("bad-key");
    expect(planPresign("backups/2026-08-31.json", "put", ME).decision).toBe("bad-key");
  });

  it("isPresignOp accepts exactly the three real ops", () => {
    expect(["get", "put", "delete"].every(isPresignOp)).toBe(true);
    expect(isPresignOp("head")).toBe(false);
    expect(isPresignOp(undefined)).toBe(false);
  });
});

describe("planPresign · audio, unchanged by 0043", () => {
  it("gates a band-scoped key on the band, read vs write", () => {
    expect(planPresign(`${TENANT}/${BAND}/songs/s-ab12.wav`, "get", ME)).toEqual({
      decision: "ask",
      rpc: "can_view_group",
      arg: { gid: BAND },
    });
    expect(planPresign(`${TENANT}/${BAND}/songs/s-ab12.wav`, "put", ME)).toEqual({
      decision: "ask",
      rpc: "can_edit_group",
      arg: { gid: BAND },
    });
    expect(planPresign(`${TENANT}/${BAND}/ev/it-ab12.wav`, "delete", ME)).toEqual({
      decision: "ask",
      rpc: "can_edit_group",
      arg: { gid: BAND },
    });
  });

  it("falls back to the tenant predicates for a legacy 3-segment key", () => {
    expect(planPresign(`${TENANT}/event/item`, "get", ME)).toEqual({
      decision: "ask",
      rpc: "is_tenant_member",
      arg: { tid: TENANT },
    });
    expect(planPresign(`${TENANT}/event/item`, "put", ME)).toEqual({
      decision: "ask",
      rpc: "can_edit_tenant",
      arg: { tid: TENANT },
    });
  });
});

describe("planPresign · feedback attachments (0043)", () => {
  it("lets the author write into their OWN folder, still checking membership", () => {
    expect(planPresign(feedbackKey(TENANT, ME), "put", ME)).toEqual({
      decision: "ask",
      rpc: "is_tenant_member",
      arg: { tid: TENANT },
    });
  });

  it("refuses a write into ANOTHER person's folder outright", () => {
    // Not "ask an admin predicate" — deny. Nobody, admin included, has business
    // planting bytes under someone else's name.
    expect(planPresign(feedbackKey(TENANT, SOMEONE_ELSE), "put", ME).decision).toBe(
      "deny"
    );
  });

  it("refuses to write into ANOTHER tenant's prefix even in your own folder", () => {
    // The rpc runs under the caller's session, so is_tenant_member(otherTenant) is
    // false for them — the plan still has to ASK rather than allow on key shape.
    const plan = planPresign(feedbackKey(OTHER_TENANT, ME), "put", ME);
    expect(plan).toEqual({
      decision: "ask",
      rpc: "is_tenant_member",
      arg: { tid: OTHER_TENANT },
    });
  });

  it("lets the author read and remove their own attachment with no round trip", () => {
    expect(planPresign(feedbackKey(TENANT, ME), "get", ME).decision).toBe("allow");
    expect(planPresign(feedbackKey(TENANT, ME), "delete", ME).decision).toBe("allow");
  });

  it("makes ANOTHER member's screenshot an ADMIN question, never a member one", () => {
    // This is the whole privacy point: is_tenant_member here would open every
    // screenshot in the label to all 19 accounts, which is broader than
    // feedback_select ("user_id = auth.uid() or can_admin_tenant(tenant_id)").
    const plan = planPresign(feedbackKey(TENANT, SOMEONE_ELSE), "get", ME);
    expect(plan).toEqual({
      decision: "ask",
      rpc: "can_admin_tenant",
      arg: { tid: TENANT },
    });
    expect(plan).not.toMatchObject({ rpc: "is_tenant_member" });
  });

  it("matches the author id case-insensitively (uuids travel in both cases)", () => {
    expect(planPresign(feedbackKey(TENANT, ME.toUpperCase()), "get", ME).decision).toBe(
      "allow"
    );
  });

  it("refuses a non-image file, and anything that is not the <rand>.<ext> shape", () => {
    for (const bad of [
      "abcd1234abcd1234.exe",
      "abcd1234abcd1234.svg", // scriptable — deliberately not on the list
      "abcd1234abcd1234", // no extension
      "ab.png", // token too short
      "abcd 1234.png", // space
      "../../etc/passwd.png",
    ]) {
      expect(planPresign(feedbackKey(TENANT, ME, bad), "put", ME).decision).toBe(
        "bad-key"
      );
    }
  });

  it("is not reachable by a key that merely CONTAINS the word feedback", () => {
    // A band whose id sat in segment 1 must keep taking the band branch, and a
    // 3-segment "<tenant>/feedback/x.png" is not the attachment shape at all.
    expect(planPresign(`${TENANT}/feedback/abcd1234.png`, "put", ME)).toEqual({
      decision: "ask",
      rpc: "can_edit_tenant",
      arg: { tid: TENANT },
    });
    expect(planPresign(`${TENANT}/${BAND}/feedback/abcd1234.png`, "get", ME)).toEqual({
      decision: "ask",
      rpc: "can_view_group",
      arg: { gid: BAND },
    });
  });
});

describe("the client builder and the server pattern agree", () => {
  // Two files, one rule. A type the picker accepts but the route rejects is a 400
  // the person reads as "แนบรูปไม่ได้" with nothing to explain it.
  it.each(FEEDBACK_IMAGE_EXTS)("a .%s the picker allows is a key the route allows", (ext) => {
    const key = buildFeedbackImagePath(TENANT, ME, `screenshot.${ext}`);
    expect(key.startsWith(`${TENANT}/feedback/${ME}/`)).toBe(true);
    expect(FEEDBACK_IMAGE_FILE.test(key.split("/")[3])).toBe(true);
    expect(planPresign(key, "put", ME).decision).toBe("ask");
    expect(planPresign(key, "get", ME).decision).toBe("allow");
  });

  it("an unknown extension is rewritten to .png rather than minted un-signable", () => {
    const key = buildFeedbackImagePath(TENANT, ME, "clipboard.bmp");
    expect(key.endsWith(".png")).toBe(true);
    expect(planPresign(key, "put", ME).decision).toBe("ask");
  });

  it("a file with no extension at all still produces a signable key", () => {
    const key = buildFeedbackImagePath(TENANT, ME, "pasted-image");
    expect(planPresign(key, "put", ME).decision).toBe("ask");
  });

  it("two keys built back to back differ", () => {
    const a = buildFeedbackImagePath(TENANT, ME, "a.png");
    const b = buildFeedbackImagePath(TENANT, ME, "a.png");
    expect(a).not.toBe(b);
  });
});
