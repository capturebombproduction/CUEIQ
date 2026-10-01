import { describe, expect, it } from "vitest";
import { activeNavHref } from "@/components/main-nav";

const MEMBER = ["/dashboard", "/library", "/practice", "/groups"];
const STAFF = ["/overview", "/groups", "/crew"];

describe("activeNavHref", () => {
  it("lights the link whose page you are on", () => {
    expect(activeNavHref("/dashboard", MEMBER)).toBe("/dashboard");
    expect(activeNavHref("/library", MEMBER)).toBe("/library");
    expect(activeNavHref("/groups/abc", MEMBER)).toBe("/groups");
  });

  it("a show page counts as Events, where people spend their time", () => {
    expect(activeNavHref("/events/42", MEMBER)).toBe("/dashboard");
    expect(activeNavHref("/events/42/live", MEMBER)).toBe("/dashboard");
    expect(activeNavHref("/events/new", MEMBER)).toBe("/dashboard");
  });

  it("a show's practice room counts as Training", () => {
    expect(activeNavHref("/events/42/practice", MEMBER)).toBe("/practice");
  });

  it("label staff have no Events link, so a show page lights Overview", () => {
    expect(activeNavHref("/events/42", STAFF)).toBe("/overview");
    expect(activeNavHref("/events/42/practice", STAFF)).toBe("/overview");
  });

  it("does not light a link for a page that is not one of them", () => {
    expect(activeNavHref("/feedback", MEMBER)).toBeNull();
    // a prefix that is not a path segment must not match
    expect(activeNavHref("/libraryx", MEMBER)).toBeNull();
  });
});
