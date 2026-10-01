import { describe, expect, it } from "vitest";
import {
  activeNavHref,
  activeTabHref,
  bottomTabsFor,
  MORE_HREF,
  navLinksFor,
} from "@/components/main-nav";
import { makePerms, type Perms } from "@/lib/permissions";

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

// Built the way getWorkspace builds them (lib/queries.ts): the tenant_members role,
// plus group_roles rows for band people — an Ar is a tenant "member" whose band row
// says artist_manager (same shape as the zz-gallery fixtures).
const BAND = "band-a";
const ROLES: Record<string, Perms> = {
  member: makePerms("member", [{ group_id: BAND, role: "member" }]),
  ar: makePerms("member", [{ group_id: BAND, role: "artist_manager" }]),
  admin: makePerms("admin"),
  ceo: makePerms("ceo"),
  labelStaff: makePerms("label_staff"),
  // signed in, not yet put in a band: no Overview, no Library
  bandless: makePerms("member", []),
};
const hrefs = (links: { href: string }[]) => links.map((l) => l.href);

describe("bottomTabsFor", () => {
  it("band people get Events, Training, Library up front", () => {
    for (const who of ["member", "ar"]) {
      const { tabs, more } = bottomTabsFor(ROLES[who]);
      expect(hrefs(tabs), who).toEqual(["/dashboard", "/practice", "/library", MORE_HREF]);
      expect(hrefs(more), who).toEqual(["/overview", "/groups", "/feedback"]);
    }
  });

  it("admin and CEO read across bands: Events, Overview, Library", () => {
    const admin = bottomTabsFor(ROLES.admin);
    expect(hrefs(admin.tabs)).toEqual(["/dashboard", "/overview", "/library", MORE_HREF]);
    expect(hrefs(admin.more)).toEqual(["/practice", "/groups", "/crew", "/admin", "/feedback"]);
    // CEO is neither approver nor admin — no Crew, no Admin anywhere
    const ceo = bottomTabsFor(ROLES.ceo);
    expect(hrefs(ceo.tabs)).toEqual(["/dashboard", "/overview", "/library", MORE_HREF]);
    expect(hrefs(ceo.more)).toEqual(["/practice", "/groups", "/feedback"]);
  });

  it("label staff get Overview, Artists, Crew — and never Events, Library or Training", () => {
    const { tabs, more } = bottomTabsFor(ROLES.labelStaff);
    expect(hrefs(tabs)).toEqual(["/overview", "/groups", "/crew", MORE_HREF]);
    expect(hrefs(more)).toEqual(["/feedback"]);
  });

  it("a slot whose destination the account lacks goes to the next link, not to nothing", () => {
    const { tabs, more } = bottomTabsFor(ROLES.bandless);
    expect(hrefs(tabs)).toEqual(["/dashboard", "/practice", "/groups", MORE_HREF]);
    expect(hrefs(more)).toEqual(["/feedback"]);
  });

  it("offers exactly the role's nav links, each once, plus Feedback — never one it cannot use", () => {
    for (const [who, perms] of Object.entries(ROLES)) {
      const { tabs, more } = bottomTabsFor(perms);
      const offered = [...hrefs(tabs), ...hrefs(more)].filter(
        (h) => h !== MORE_HREF && h !== "/feedback"
      );
      expect(new Set(offered).size, who).toBe(offered.length);
      expect([...offered].sort(), who).toEqual(hrefs(navLinksFor(perms)).sort());
      expect(tabs.at(-1), who).toEqual({ href: MORE_HREF, label: "More" });
      expect(tabs.length, who).toBeLessThanOrEqual(4);
    }
  });
});

describe("activeTabHref", () => {
  const at = (who: string, pathname: string) =>
    activeTabHref(pathname, bottomTabsFor(ROLES[who]));

  it("lights the tab whose page you are on, show pages included", () => {
    expect(at("member", "/dashboard")).toBe("/dashboard");
    expect(at("member", "/events/42")).toBe("/dashboard");
    expect(at("member", "/events/42/live")).toBe("/dashboard");
    expect(at("member", "/events/42/practice")).toBe("/practice");
    expect(at("labelStaff", "/events/42")).toBe("/overview");
    expect(at("labelStaff", "/crew")).toBe("/crew");
    expect(at("ceo", "/library")).toBe("/library");
  });

  it("lights More when the page lives in the More sheet", () => {
    expect(at("member", "/groups")).toBe(MORE_HREF);
    expect(at("member", "/groups/abc")).toBe(MORE_HREF);
    expect(at("member", "/overview")).toBe(MORE_HREF);
    expect(at("member", "/feedback")).toBe(MORE_HREF);
    expect(at("admin", "/admin")).toBe(MORE_HREF);
    expect(at("admin", "/crew")).toBe(MORE_HREF);
    // a show's practice room is Training, which an admin keeps in More
    expect(at("admin", "/events/42/practice")).toBe(MORE_HREF);
    expect(at("labelStaff", "/feedback")).toBe(MORE_HREF);
  });

  it("lights nothing for a page that is none of the role's destinations", () => {
    expect(at("member", "/admin")).toBeNull();
    expect(at("member", "/")).toBeNull();
    expect(at("member", "/libraryx")).toBeNull();
  });
});
