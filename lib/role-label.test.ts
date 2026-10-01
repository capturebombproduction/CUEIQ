import { describe, it, expect } from "vitest";
import { makePerms } from "@/lib/permissions";
import { accountLine, roleLabel } from "./role-label";

const SEISHIN = { id: "g1", name: "Seishin Kakumei" };
const HOSHI = { id: "g2", name: "Hoshizora" };
const groups = [SEISHIN, HOSHI];
const band = (role: "member" | "artist_manager", group_id = "g1") =>
  ({ group_id, role }) as never;

describe("roleLabel (moved out of the two headers, unchanged)", () => {
  it("a band account shows its real per-band role, not the inert tenant `member`", () => {
    expect(roleLabel("member", makePerms("member", [band("member")]))).toBe("สมาชิก");
    expect(roleLabel("member", makePerms("member", [band("artist_manager")]))).toBe("Ar");
  });
  it("a label-wide account shows the tenant role", () => {
    expect(roleLabel("admin", makePerms("admin"))).toBe("Admin");
    expect(roleLabel("label_staff", makePerms("label_staff"))).toBe("Label");
  });
});

describe("accountLine — the account panel's 'role · where'", () => {
  it("places a band person by their band", () => {
    const perms = makePerms("member", [band("member")]);
    expect(accountLine({ role: "member", perms, groups, tenantName: "A Lot Of Tone" })).toBe(
      "สมาชิก · Seishin Kakumei"
    );
  });
  it("two bands: the first plus a count, so the line still fits a phone", () => {
    const perms = makePerms("member", [band("artist_manager"), band("member", "g2")]);
    expect(accountLine({ role: "member", perms, groups })).toBe("Ar · Seishin Kakumei +1");
  });
  it("places a label-wide account by the label", () => {
    expect(
      accountLine({ role: "ceo", perms: makePerms("ceo"), groups, tenantName: "A Lot Of Tone" })
    ).toBe("CEO · A Lot Of Tone");
  });
  it("with no band names to hand (a failed read), says the role alone — never the label as their band", () => {
    const perms = makePerms("member", [band("member")]);
    expect(accountLine({ role: "member", perms, groups: [], tenantName: "A Lot Of Tone" })).toBe(
      "สมาชิก"
    );
  });
});
