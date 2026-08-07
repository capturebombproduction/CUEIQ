import { describe, expect, it } from "vitest";
import {
  describeDeadEnd,
  eventIdFromLink,
  mayMarkRead,
  notificationReachability,
  runOrderLinksFor,
  runOrderLiveLink,
  runOrderPushBody,
  RUN_ORDER_FALLBACK_LINK,
} from "./dead-link";

// Stand-ins for the real label: 8 bands, 19 accounts, one festival.
const SEISHIN = "g-seishin";
const VNX = "g-vnx";
const TERASHI = "g-terashi";
const EV_SEISHIN = "1111aaaa-0000-4000-8000-000000000001";
const EV_VNX = "2222bbbb-0000-4000-8000-000000000002";
const FESTIVAL = [
  { id: EV_SEISHIN, group_id: SEISHIN },
  { id: EV_VNX, group_id: VNX },
];

describe("runOrderLinksFor", () => {
  it("gives label-wide roles the deep link to the entry event", () => {
    const links = runOrderLinksFor({
      recipientIds: ["u-admin", "u-ceo", "u-staff"],
      members: [
        { user_id: "u-admin", role: "admin" },
        { user_id: "u-ceo", role: "ceo" },
        { user_id: "u-staff", role: "label_staff" },
      ],
      festivalEvents: FESTIVAL,
      groupRoles: [],
      entryEventId: EV_SEISHIN,
    });
    for (const uid of ["u-admin", "u-ceo", "u-staff"]) {
      expect(links.get(uid)).toBe(runOrderLiveLink(EV_SEISHIN));
    }
  });

  // The bug itself: the blast went to all 19 accounts carrying ONE band's event id,
  // which RLS (can_view_group) hides from every other band → notFound().
  it("rewrites a band-tier recipient onto their OWN band's event, not the entry one", () => {
    const links = runOrderLinksFor({
      recipientIds: ["u-vnx-member"],
      members: [{ user_id: "u-vnx-member", role: "member" }],
      festivalEvents: FESTIVAL,
      groupRoles: [{ user_id: "u-vnx-member", group_id: VNX }],
      entryEventId: EV_SEISHIN,
    });
    expect(links.get("u-vnx-member")).toBe(runOrderLiveLink(EV_VNX));
    expect(links.get("u-vnx-member")).not.toContain(EV_SEISHIN);
  });

  it("sends a member of a band that isn't in this festival to the safe fallback", () => {
    const links = runOrderLinksFor({
      recipientIds: ["u-terashi-member"],
      members: [{ user_id: "u-terashi-member", role: "member" }],
      festivalEvents: FESTIVAL,
      groupRoles: [{ user_id: "u-terashi-member", group_id: TERASHI }],
      entryEventId: EV_SEISHIN,
    });
    expect(links.get("u-terashi-member")).toBe(RUN_ORDER_FALLBACK_LINK);
  });

  it("falls back rather than guessing when the lookups came back empty", () => {
    const links = runOrderLinksFor({
      recipientIds: ["u-ar"],
      members: [],
      festivalEvents: [],
      groupRoles: [],
      entryEventId: EV_SEISHIN,
    });
    expect(links.get("u-ar")).toBe(RUN_ORDER_FALLBACK_LINK);
  });

  it("is stable when an Ar manages two bands in the same festival", () => {
    const input = {
      recipientIds: ["u-double-ar"],
      members: [{ user_id: "u-double-ar", role: "artist_manager" }],
      festivalEvents: FESTIVAL,
      groupRoles: [
        { user_id: "u-double-ar", group_id: VNX },
        { user_id: "u-double-ar", group_id: SEISHIN },
      ],
      entryEventId: EV_SEISHIN,
    };
    const a = runOrderLinksFor(input).get("u-double-ar");
    const b = runOrderLinksFor({
      ...input,
      groupRoles: [...input.groupRoles].reverse(),
      festivalEvents: [...FESTIVAL].reverse(),
    }).get("u-double-ar");
    // the bell row and the phone's push must never disagree about the destination
    expect(a).toBe(b);
    expect(a).toBe(runOrderLiveLink(EV_SEISHIN));
  });

  it("ignores an event with no band rather than emitting a broken link", () => {
    const links = runOrderLinksFor({
      recipientIds: ["u-member"],
      members: [{ user_id: "u-member", role: "member" }],
      festivalEvents: [{ id: EV_SEISHIN, group_id: null }],
      groupRoles: [{ user_id: "u-member", group_id: SEISHIN }],
      entryEventId: EV_SEISHIN,
    });
    expect(links.get("u-member")).toBe(RUN_ORDER_FALLBACK_LINK);
  });

  it("answers for every recipient it was given", () => {
    const ids = ["a", "b", "c"];
    const links = runOrderLinksFor({
      recipientIds: ids,
      members: [],
      festivalEvents: FESTIVAL,
      groupRoles: [],
      entryEventId: EV_SEISHIN,
    });
    expect([...links.keys()].sort()).toEqual(ids);
  });
});

describe("runOrderPushBody", () => {
  it("promises the live board only to a recipient whose link opens it", () => {
    expect(runOrderPushBody("ROCK FEST", runOrderLiveLink(EV_VNX))).toContain(
      "เปิดดูคิวงานสดได้เลย"
    );
  });

  // The whole point: the link went per-recipient and the body did not, so a member
  // of a band that isn't playing got a push telling them to open a live cue that
  // /overview gives them no button for.
  it("does NOT promise the live board to a recipient on the /overview fallback", () => {
    const body = runOrderPushBody("ROCK FEST", RUN_ORDER_FALLBACK_LINK);
    expect(body).not.toContain("เปิดดูคิวงานสดได้เลย");
    expect(body).toContain("งานเริ่มแล้ว");
    expect(body).toContain("ROCK FEST");
  });

  // The link and the body must be decided from the same value for every recipient
  // runOrderLinksFor answers for — this is the pairing that broke.
  it("stays in step with runOrderLinksFor for every recipient", () => {
    const links = runOrderLinksFor({
      recipientIds: ["u-admin", "u-vnx-member", "u-terashi-member"],
      members: [
        { user_id: "u-admin", role: "admin" },
        { user_id: "u-vnx-member", role: "member" },
        { user_id: "u-terashi-member", role: "member" },
      ],
      festivalEvents: FESTIVAL,
      groupRoles: [
        { user_id: "u-vnx-member", group_id: VNX },
        { user_id: "u-terashi-member", group_id: TERASHI },
      ],
      entryEventId: EV_SEISHIN,
    });
    for (const [uid, link] of links) {
      const promisesBoard = runOrderPushBody("ROCK FEST", link).includes(
        "เปิดดูคิวงานสดได้เลย"
      );
      expect(promisesBoard).toBe(link !== RUN_ORDER_FALLBACK_LINK);
      expect(promisesBoard).toBe(uid !== "u-terashi-member");
    }
  });

  it("never renders an empty festival name", () => {
    expect(runOrderPushBody("", RUN_ORDER_FALLBACK_LINK).startsWith("งาน")).toBe(true);
    expect(runOrderPushBody("", runOrderLiveLink(EV_VNX)).startsWith("งาน")).toBe(true);
  });
});

describe("eventIdFromLink", () => {
  it("reads both link shapes the notify route stores", () => {
    expect(eventIdFromLink(`/events/${EV_VNX}`)).toBe(EV_VNX);
    expect(eventIdFromLink(`/events/${EV_VNX}/run-order/live`)).toBe(EV_VNX);
    expect(eventIdFromLink(`/events/${EV_VNX}?from=overview`)).toBe(EV_VNX);
  });

  it("ignores links that don't address an event", () => {
    expect(eventIdFromLink("/library")).toBeNull();
    expect(eventIdFromLink("/overview")).toBeNull();
    expect(eventIdFromLink("/events")).toBeNull();
    expect(eventIdFromLink("/events/new")).toBeNull();
    expect(eventIdFromLink(null)).toBeNull();
    expect(eventIdFromLink("")).toBeNull();
  });
});

describe("notificationReachability", () => {
  const viewable = new Set([EV_SEISHIN]);

  it("passes through anything that doesn't point at an event", () => {
    expect(notificationReachability("/library", new Set())).toBe("ok");
    expect(notificationReachability(null, new Set())).toBe("ok");
  });

  it("is ok when the event is readable", () => {
    expect(notificationReachability(`/events/${EV_SEISHIN}`, viewable)).toBe("ok");
  });

  // The eight production rows: seeded 🧪 TEST FEST events that were later deleted.
  it("is gone when the event isn't in the readable set", () => {
    expect(notificationReachability(`/events/${EV_VNX}`, viewable)).toBe("gone");
  });

  // An empty read is not an empty table — the bell hands us null when it could not
  // trust the probe, and null must never gray an item out.
  it("never downgrades an item on an untrusted probe", () => {
    expect(notificationReachability(`/events/${EV_VNX}`, null)).toBe("unknown");
    expect(notificationReachability(`/events/${EV_SEISHIN}`, null)).toBe("unknown");
  });
});

describe("mayMarkRead", () => {
  it("authorises the write only on a real answer", () => {
    expect(mayMarkRead("ok")).toBe(true);
    expect(mayMarkRead("gone")).toBe(false);
    // The window the bug actually shipped in twice: the notifications read has
    // landed and painted the unread badge, the events probe has not answered yet.
    expect(mayMarkRead("unknown")).toBe(false);
  });

  // Navigating and writing are different decisions. The bell fails OPEN on the link
  // below (it navigates, because a wrong 404 is recoverable); this pins that the
  // same verdict must not also clear the item's unread flag, which nothing undoes.
  it("refuses the write for the very verdict the bell navigates on", () => {
    const reach = notificationReachability(`/events/${EV_VNX}`, null);
    expect(reach).toBe("unknown");
    expect(mayMarkRead(reach)).toBe(false);
  });

  // A row that points at /library or carries no link has nothing to check, so it is
  // "ok" and must stay writable — otherwise the guard would leave half the bell
  // permanently unread.
  it("leaves items with no event target fully writable", () => {
    expect(mayMarkRead(notificationReachability("/library", null))).toBe(true);
    expect(mayMarkRead(notificationReachability(null, null))).toBe(true);
  });
});

describe("describeDeadEnd", () => {
  it("names both causes on an event URL, because both are possible", () => {
    const d = describeDeadEnd(`/events/${EV_VNX}`);
    expect(d.heading).toBe("ไม่พบงานนี้");
    expect(d.detail).toContain("ถูกลบ");
    expect(d.detail).toContain("ไม่มีสิทธิ์");
    expect(d.backHref).toBe("/overview");
  });

  it("treats a deep link inside the live board the same way", () => {
    expect(describeDeadEnd(`/events/${EV_VNX}/run-order/live?from=overview`).heading).toBe(
      "ไม่พบงานนี้"
    );
  });

  it("uses the record wording for other in-app records", () => {
    const d = describeDeadEnd("/groups/abc");
    expect(d.heading).toBe("ไม่พบรายการนี้");
    expect(d.backHref).toBe("/dashboard");
  });

  it("is definite about a URL the product simply doesn't have", () => {
    for (const p of ["/nope", "/", "", null, undefined, "/events", "/library"]) {
      const d = describeDeadEnd(p);
      expect(d.heading).toBe("ไม่พบหน้านี้");
      expect(d.detail).not.toContain("ไม่มีสิทธิ์");
      expect(d.backHref).toBe("/dashboard");
    }
  });

  it("always offers a way back", () => {
    for (const p of ["/events/x", "/admin/users", "/whatever", "/practice/1"]) {
      const d = describeDeadEnd(p);
      expect(d.backHref.startsWith("/")).toBe(true);
      expect(d.backLabel.length).toBeGreaterThan(0);
    }
  });
});
