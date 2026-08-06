import { describe, expect, it } from "vitest";
import { applicationServerKeyMatches } from "./push-key-match";

describe("applicationServerKeyMatches", () => {
  it("matches identical keys", () => {
    const key = new Uint8Array([1, 2, 3, 4]);
    expect(applicationServerKeyMatches(key.buffer, key)).toBe(true);
  });

  it("detects a rotated key of the same length", () => {
    const old = new Uint8Array([1, 2, 3, 4]);
    const rotated = new Uint8Array([1, 2, 3, 9]);
    expect(applicationServerKeyMatches(old.buffer, rotated)).toBe(false);
  });

  it("detects a length mismatch without throwing", () => {
    const old = new Uint8Array([1, 2, 3]);
    const rotated = new Uint8Array([1, 2, 3, 4]);
    expect(applicationServerKeyMatches(old.buffer, rotated)).toBe(false);
  });

  // Older Safari doesn't report options.applicationServerKey back on an
  // existing subscription — treat "can't verify" as "leave it alone", not as
  // a mismatch that would unsubscribe a possibly still-valid subscription.
  it("treats a null current key as unverifiable, not a mismatch", () => {
    const expected = new Uint8Array([1, 2, 3, 4]);
    expect(applicationServerKeyMatches(null, expected)).toBe(true);
  });
});
