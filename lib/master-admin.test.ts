import { describe, expect, it } from "vitest";
import { MASTER_ADMIN_EMAILS, isMasterAdminEmail } from "./master-admin";

// The Master Admin guard lives in code (not a DB flag) so it can't be cleared by
// another admin or a stray service-role write. This locks the identity match so a
// refactor can't silently widen or drop the protection.
describe("isMasterAdminEmail", () => {
  const master = MASTER_ADMIN_EMAILS[0];

  it("matches the protected account, case-insensitively and trimmed", () => {
    expect(isMasterAdminEmail(master)).toBe(true);
    expect(isMasterAdminEmail(master.toUpperCase())).toBe(true);
    expect(isMasterAdminEmail(`  ${master}  `)).toBe(true);
  });
  it("does not match any other account", () => {
    expect(isMasterAdminEmail("architect@gmail.com")).toBe(false);
    expect(isMasterAdminEmail("admin@cueiq.local")).toBe(false);
  });
  it("is safe on nullish / empty input", () => {
    expect(isMasterAdminEmail(null)).toBe(false);
    expect(isMasterAdminEmail(undefined)).toBe(false);
    expect(isMasterAdminEmail("")).toBe(false);
  });
});
