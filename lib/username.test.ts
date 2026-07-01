import { describe, expect, it } from "vitest";
import {
  INTERNAL_EMAIL_DOMAIN,
  displayLoginId,
  isValidLoginId,
  loginIdToEmail,
} from "./username";

// Login accepts EITHER a bare username ("ar01") or a real email. A regression
// here breaks sign-in for the whole label or routes a username to the wrong
// synthetic address, so pin down every branch.

describe("isValidLoginId", () => {
  it("accepts bare usernames (lowercased + trimmed)", () => {
    for (const v of ["ar01", "AR01", "  ar01  ", "ar_01.test-2", "member"]) {
      expect(isValidLoginId(v)).toBe(true);
    }
  });
  it("accepts full emails", () => {
    expect(isValidLoginId("nutthapat@gmail.com")).toBe(true);
    expect(isValidLoginId("Foo@Bar.co")).toBe(true);
  });
  it("rejects blank input", () => {
    expect(isValidLoginId("")).toBe(false);
    expect(isValidLoginId("   ")).toBe(false);
  });
  it("rejects usernames with illegal characters", () => {
    expect(isValidLoginId("bad user")).toBe(false); // space
    expect(isValidLoginId("user!")).toBe(false); // punctuation
  });
  it("rejects a malformed email (has @ but no domain dot)", () => {
    expect(isValidLoginId("foo@bar")).toBe(false);
  });
});

describe("loginIdToEmail", () => {
  it("wraps a bare username into the synthetic internal email", () => {
    expect(loginIdToEmail("ar01")).toBe(`ar01@${INTERNAL_EMAIL_DOMAIN}`);
    expect(loginIdToEmail("  AR01 ")).toBe(`ar01@${INTERNAL_EMAIL_DOMAIN}`);
  });
  it("passes a real email through untouched (but lowercased/trimmed)", () => {
    expect(loginIdToEmail("nutthapat@gmail.com")).toBe("nutthapat@gmail.com");
    expect(loginIdToEmail("  Foo@Gmail.com ")).toBe("foo@gmail.com");
  });
});

describe("displayLoginId", () => {
  it("strips the synthetic domain back to a bare username", () => {
    expect(displayLoginId(`ar01@${INTERNAL_EMAIL_DOMAIN}`)).toBe("ar01");
  });
  it("shows a real email as-is", () => {
    expect(displayLoginId("nutthapat@gmail.com")).toBe("nutthapat@gmail.com");
  });
  it("only strips an EXACT trailing synthetic domain", () => {
    // ends with ".com", not "@cueiq.local" → left intact
    expect(displayLoginId(`x@${INTERNAL_EMAIL_DOMAIN}.com`)).toBe(
      `x@${INTERNAL_EMAIL_DOMAIN}.com`
    );
  });
  it("handles nullish input", () => {
    expect(displayLoginId(null)).toBe("");
    expect(displayLoginId(undefined)).toBe("");
    expect(displayLoginId("")).toBe("");
  });
});

describe("loginIdToEmail ∘ displayLoginId round-trips a username", () => {
  it("username → email → username", () => {
    expect(displayLoginId(loginIdToEmail("ar01"))).toBe("ar01");
  });
});
