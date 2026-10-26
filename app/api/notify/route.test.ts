// ---------------------------------------------------------------------------
// song_pending GOES ONLY TO PEOPLE WHO CAN OPEN WHAT IT POINTS AT.
//
// "🎵 เพลงใหม่รอตรวจลิขสิทธิ์" fires right after a brand-new song is inserted from the
// Library, so no setlist uses it yet and the song appears on exactly one page: /library.
// canViewLibrary is false for label_staff — app/(app)/library/page.tsx redirects them to
// /dashboard, which lands on /overview — so a staff recipient had no destination where
// the song exists at all (an earlier version looked for a setlist that uses it; at this
// moment there never is one, so it always fell back to the Overview). The audience is
// therefore the admins, and every one of them gets /library.
//
// This runs the real POST handler against a fake service-role client, so it traces from
// the request to the `notifications` rows — the same rows the bell and the push read.
// lib/notify-link-routes.test.ts separately holds every destination to a real page in
// both apps.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";
import { canViewLibrary, makePerms } from "@/lib/permissions";
import type { Role } from "@/lib/types";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  /** every tenant_members row; the query's .in("role", …) filter is applied to it */
  members: [] as Row[],
  inserted: [] as Row[],
  queried: [] as string[],
  /** the role list each tenant_members audience query asked for */
  roleFilters: [] as unknown[][],
  /** what the events lookup returns (event_submitted only) */
  eventStatus: "pending_review",
  /** the songs lookup's copyright_status */
  songStatus: "pending",
  /** can_view_group under the CALLER's session */
  canView: true as boolean,
  /** can_approve under the CALLER's session, and the tenant it was asked about */
  canApprove: true as boolean,
  approveAsked: [] as unknown[],
  /** can_edit_group under the CALLER's session, and the band it was asked about */
  canEdit: true as boolean,
  editAsked: [] as unknown[],
  /** how many run_sequence rows are live (run_order_live's anti-spoof) */
  liveCount: 1,
  /** the festival's events (run_order_live's per-recipient links); eq filters apply */
  festEvents: [] as Row[],
  /** group_roles rows (run_order_live's per-recipient links) */
  groupRoles: [] as Row[],
  /** VAPID configured (Web Push on) */
  vapid: false,
  /** the push_subscriptions read fails */
  pushReadFails: false,
  /** reads that fail, as "<table>:one" (maybeSingle) or "<table>:many" (a list / a count) */
  failRead: [] as string[],
  /** the notifications insert fails */
  failInsert: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "caller" } } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "can_approve") h.approveAsked.push(args);
      if (fn === "can_edit_group") h.editAsked.push(args);
      return {
        data:
          fn === "can_view_group"
            ? h.canView
            : fn === "can_approve"
              ? h.canApprove
              : fn === "can_edit_group"
                ? h.canEdit
                : null,
        error: null,
      };
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  hasServiceRole: () => true,
  createAdminClient: () => ({ from: (t: string) => table(t) }),
}));
vi.mock("@/lib/push", () => ({ vapidConfigured: () => h.vapid, sendPush: vi.fn(async () => "ok") }));
const READ_FAILED = { data: null, count: null, error: { message: "canceling statement due to statement timeout" } };

/** A chainable, awaitable stand-in for one PostgREST query. */
function table(name: string) {
  h.queried.push(name);
  let roles: unknown[] | null = null;
  const eqs: [string, unknown][] = [];
  const single = (): Row | null => {
    if (name === "songs")
      return {
        id: "song-1",
        title: "Plus One",
        group_id: "band-1",
        tenant_id: "tenant-1",
        copyright_status: h.songStatus,
        groups: { name: "Seishin Kakumei" },
      };
    if (name === "events")
      return {
        id: "ev-1",
        name: "Plus One Live",
        group_id: "band-1",
        tenant_id: "tenant-1",
        status: h.eventStatus,
        groups: { name: "Seishin Kakumei" },
      };
    if (name === "tenant_members") return { user_id: "caller" }; // the caller belongs
    return null;
  };
  const many = (): Row[] => {
    if (name === "tenant_members")
      return h.members.filter((m) => !roles || roles.includes(m.role));
    // the festival lookup: every .eq() on a column the row has must hold
    if (name === "events")
      return h.festEvents.filter((r) => eqs.every(([c, v]) => !(c in r) || r[c] === v));
    if (name === "group_roles") return h.groupRoles;
    return []; // notifications (dedupe), push_subscriptions, …
  };
  const q: Record<string, unknown> = {};
  for (const m of ["select", "gt", "is", "or", "limit", "order"]) q[m] = () => q;
  q.eq = (col: string, val: unknown) => {
    eqs.push([col, val]);
    return q;
  };
  q.in = (col: string, vals: unknown[]) => {
    if (name === "tenant_members" && col === "role") {
      roles = vals;
      h.roleFilters.push(vals);
    }
    return q;
  };
  q.maybeSingle = async () => (h.failRead.includes(`${name}:one`) ? READ_FAILED : { data: single(), error: null });
  q.single = async () => ({ data: single(), error: null });
  q.insert = async (rows: Row | Row[]) => {
    if (name === "notifications" && h.failInsert) return { error: { message: "insert failed" } };
    if (name === "notifications") h.inserted.push(...(Array.isArray(rows) ? rows : [rows]));
    return { error: null };
  };
  q.delete = () => q;
  q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
    Promise.resolve(
      h.failRead.includes(`${name}:many`)
        ? READ_FAILED
        : name === "run_sequence"
        ? { data: null, count: h.liveCount, error: null } // select(…, { count, head })
        : name === "push_subscriptions" && h.pushReadFails
          ? { data: null, error: { message: "canceling statement due to statement timeout" } }
          : { data: many(), error: null }
    ).then(ok, bad);
  return q;
}

import { POST } from "./route";

const ADMIN = { user_id: "admin-1", role: "admin" };
const ADMIN_2 = { user_id: "admin-2", role: "admin" };
const STAFF_A = { user_id: "staff-a", role: "label_staff" };
const STAFF_B = { user_id: "staff-b", role: "label_staff" };

async function send(body: Record<string, unknown>) {
  const res = await POST(
    new Request("http://localhost/api/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  expect(res.status).toBe(200);
  return {
    res,
    links: Object.fromEntries(h.inserted.map((r) => [r.user_id as string, r.link as string])),
  };
}

beforeEach(() => {
  h.members = [ADMIN, ADMIN_2, STAFF_A, STAFF_B];
  h.inserted = [];
  h.queried = [];
  h.roleFilters = [];
  h.eventStatus = "pending_review";
  h.songStatus = "pending";
  h.canView = true;
  h.canApprove = true;
  h.approveAsked = [];
  h.canEdit = true;
  h.editAsked = [];
  h.liveCount = 1;
  h.festEvents = [];
  h.groupRoles = [];
  h.vapid = false;
  h.pushReadFails = false;
  h.failRead = [];
  h.failInsert = false;
});

describe("song_pending goes to the admins, who can open the Library", () => {
  it("notifies every admin and no label staff", async () => {
    const { links } = await send({ kind: "song_pending", songId: "song-1" });
    expect(Object.keys(links).sort()).toEqual(["admin-1", "admin-2"]);
  });

  it("sends every recipient to /library, and every recipient role can open it", async () => {
    const { links } = await send({ kind: "song_pending", songId: "song-1" });
    expect(Object.values(links)).toEqual(["/library", "/library"]);
    // The invariant, from the permission rule itself rather than from a hard-coded role:
    // whatever roles the audience query asked for, each of them may open the page.
    expect(h.roleFilters.length).toBeGreaterThan(0);
    for (const roles of h.roleFilters)
      for (const role of roles) expect(canViewLibrary(makePerms(role as Role))).toBe(true);
    // …and the premise that made label staff the wrong audience.
    expect(canViewLibrary(makePerms("label_staff"))).toBe(false);
  });

  it("does not look for a setlist that uses the song — a brand-new song is in none", async () => {
    await send({ kind: "song_pending", songId: "song-1" });
    expect(h.queried).not.toContain("setlist_items");
  });

  it("with no admin besides the person who added the song, nothing is sent", async () => {
    h.members = [{ user_id: "caller", role: "admin" }, STAFF_A, STAFF_B];
    const { res } = await send({ kind: "song_pending", songId: "song-1" });
    expect(await res.json()).toEqual({ ok: true, sent: 0 });
    expect(h.inserted).toEqual([]);
  });

  it("writes the bell row with the song, the band and the Library link", async () => {
    await send({ kind: "song_pending", songId: "song-1" });
    expect(h.inserted[0]).toMatchObject({
      type: "song_pending",
      body: "Plus One · Seishin Kakumei",
      link: "/library",
      meta: { song_id: "song-1", group_id: "band-1" },
    });
  });
});

// song_pending is the only kind whose audience changed. event_submitted shares the
// "approvers" rule's query and stays admin + label_staff, on a page both can open.
describe("the other approver kind keeps its audience and its link", () => {
  it("event_submitted still goes to admin AND label_staff, to /overview", async () => {
    const { links } = await send({ kind: "event_submitted", eventId: "ev-1" });
    expect(links).toEqual({
      "admin-1": "/overview",
      "admin-2": "/overview",
      "staff-a": "/overview",
      "staff-b": "/overview",
    });
    expect(h.queried).not.toContain("setlist_items");
  });
});

// 2026-10-07: a reviewed song the band changed goes back to pending (0047) - and says so.
describe("song_resubmitted", () => {
  it("goes to the admins, to the Library, saying the reviewed song was changed", async () => {
    const { links } = await send({ kind: "song_resubmitted", songId: "song-1" });
    expect(Object.keys(links).sort()).toEqual(["admin-1", "admin-2"]);
    expect(links["admin-1"]).toBe("/library");
    expect(String(h.inserted[0].title)).toContain("ถูกแก้");
  });
  it("needs the song to really be pending again", async () => {
    h.songStatus = "cleared";
    await send({ kind: "song_resubmitted", songId: "song-1" });
    expect(h.inserted).toEqual([]);
  });
});

// 2026-10-07 review: a member of ANOTHER band could re-send a true notice about a show
// or a song that is not theirs.
describe("the caller must be able to see the band", () => {
  it("someone who cannot see the band is refused, and nothing is written", async () => {
    h.canView = false;
    h.eventStatus = "approved";
    const res = await POST(
      new Request("http://localhost/api/notify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "event_approved", eventId: "ev-1" }),
      })
    );
    expect(res.status).toBe(403);
    expect(h.inserted).toEqual([]);
  });
});

// 2026-10-24 review (verified on the code + the live policies): "🔴 งานเริ่มแล้ว (Live)" goes to the WHOLE
// label, and its anti-spoof only proves the board IS live — true for the whole show. So
// any member of any band could re-send it to every account once per dedupe window.
// Only someone who could have started the board (can_approve, the run_sequence_update
// policy) may announce it.
describe("run_order_live comes only from someone who could start the show", () => {
  const post = (body: Record<string, unknown>) =>
    POST(
      new Request("http://localhost/api/notify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );

  it("a member who cannot approve is refused, and nothing is written", async () => {
    h.canApprove = false;
    const res = await post({ kind: "run_order_live", eventId: "ev-1" });
    expect(res.status).toBe(403);
    expect(h.inserted).toEqual([]);
    expect(h.approveAsked).toEqual([{ tid: "tenant-1" }]); // the event's tenant, not one from the body
  });

  it("an approver who started it reaches the whole label", async () => {
    h.members = [ADMIN, STAFF_A, { user_id: "member-1", role: "member" }];
    const { res } = await send({ kind: "run_order_live", eventId: "ev-1" });
    expect(await res.json()).not.toEqual({ ok: true, sent: 0 });
    expect(h.inserted.map((r) => r.user_id).sort()).toEqual(["admin-1", "member-1", "staff-a"]);
    expect(h.inserted.every((r) => r.type === "run_order_live")).toBe(true);
  });

  it("a band member is linked to the band's real show, never to a practice room or template of the same name", async () => {
    h.members = [ADMIN, { user_id: "member-1", role: "member" }];
    h.groupRoles = [{ user_id: "member-1", group_id: "band-1" }];
    const ev = (id: string, extra: Row = {}) => ({
      id,
      group_id: "band-1",
      tenant_id: "tenant-1",
      name: "Plus One Live",
      is_template: false,
      is_practice: false,
      ...extra,
    });
    // smaller ids first: without the filters either one wins the tie-break
    h.festEvents = [ev("aa-practice", { is_practice: true }), ev("ab-template", { is_template: true }), ev("ev-1")];
    const { links } = await send({ kind: "run_order_live", eventId: "ev-1" });
    expect(links["member-1"]).toBe("/events/ev-1/run-order/live");
  });

  it("a board that is not live still sends nothing, approver or not", async () => {
    h.liveCount = 0;
    await send({ kind: "run_order_live", eventId: "ev-1" });
    expect(h.inserted).toEqual([]);
  });
});

// 2026-10-25 review: the push_subscriptions read coalesced a failure to [] and answered
// ok with sent: 0 - "nobody has a device" - so a broken read never showed anywhere.
describe("a failed push_subscriptions read is an error, never 'nobody has a device'", () => {
  it("answers 500 naming the read; the bell rows are still written", async () => {
    h.vapid = true;
    h.pushReadFails = true;
    const res = await POST(
      new Request("http://localhost/api/notify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "event_submitted", eventId: "ev-1" }),
      })
    );
    expect(res.status).toBe(500);
    expect(String((await res.json()).error)).toContain("push_subscriptions");
    expect(h.inserted.map((r) => r.user_id).sort()).toEqual(["admin-1", "admin-2", "staff-a", "staff-b"]);
  });

  it("a read that worked still answers ok", async () => {
    h.vapid = true;
    const { res } = await send({ kind: "event_submitted", eventId: "ev-1" });
    expect(await res.json()).toMatchObject({ ok: true, recipients: 4 });
  });
});

// 2026-10-26: every other read the route makes coalesced a failure the same way. A failed
// subject / live-row / membership / audience read answered ok with sent: 0 ("nothing to
// send"); a failed dedupe read was "nobody was told yet" and told everyone again; a failed
// bell insert still pushed (a push with no bell row, and no row for the next dedupe to see).
// Each is now a 500 naming the read, before anything is written or pushed.
describe("a failed read is an error, never 'nothing to send' or 'nobody told yet'", () => {
  const post = (body: Record<string, unknown>) =>
    POST(
      new Request("http://localhost/api/notify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  const refused = async (body: Record<string, unknown>, what: string) => {
    const res = await post(body);
    expect(res.status).toBe(500);
    expect(String((await res.json()).error)).toContain(what);
    expect(h.inserted).toEqual([]);
  };

  it("the show's subject read (events)", async () => {
    h.failRead = ["events:one"];
    await refused({ kind: "event_submitted", eventId: "ev-1" }, "events");
  });
  it("the feedback's subject read (feedback)", async () => {
    h.failRead = ["feedback:one"];
    await refused({ kind: "feedback_replied", feedbackId: "fb-1" }, "feedback");
  });
  it("the song's subject read (songs)", async () => {
    h.failRead = ["songs:one"];
    await refused({ kind: "song_pending", songId: "song-1" }, "songs");
  });
  it("run_order_live: the festival's event read, and its live-row count", async () => {
    h.failRead = ["events:one"];
    await refused({ kind: "run_order_live", eventId: "ev-1" }, "events");
    h.failRead = ["run_sequence:many"];
    await refused({ kind: "run_order_live", eventId: "ev-1" }, "run_sequence");
  });
  it("the caller's membership read: an error, not 'forbidden'", async () => {
    h.failRead = ["tenant_members:one"];
    await refused({ kind: "event_submitted", eventId: "ev-1" }, "tenant_members");
  });
  it("the audience read", async () => {
    h.failRead = ["tenant_members:many"];
    await refused({ kind: "event_submitted", eventId: "ev-1" }, "tenant_members");
    h.failRead = ["group_roles:many"];
    h.eventStatus = "approved";
    await refused({ kind: "event_approved", eventId: "ev-1" }, "group_roles");
  });
  it("the dedupe read: nobody is told again on a guess", async () => {
    h.vapid = true;
    h.failRead = ["notifications:many"];
    const { sendPush } = await import("@/lib/push");
    vi.mocked(sendPush).mockClear();
    await refused({ kind: "run_order_live", eventId: "ev-1" }, "notifications");
    expect(sendPush).not.toHaveBeenCalled();
  });
  it("the bell insert: no push goes out without its bell row", async () => {
    h.vapid = true;
    h.failInsert = true;
    const { sendPush } = await import("@/lib/push");
    vi.mocked(sendPush).mockClear();
    const res = await post({ kind: "event_submitted", eventId: "ev-1" });
    expect(res.status).toBe(500);
    expect(String((await res.json()).error)).toContain("notifications");
    expect(sendPush).not.toHaveBeenCalled();
  });
});

// 2026-10-25 review: 651546d gated only run_order_live. Every other kind has the same
// shape - the anti-spoof proves the state is TRUE and 3b proves the caller can SEE the
// band - so a plain member could re-send "📋 งานรออนุมัติ" to every approver (or
// "✅ อนุมัติงานแล้ว" to the band's Ar) once per dedupe window for as long as the state
// held. Each kind now comes only from someone who could have made that transition:
// submit / new song / resubmit = an editor of the band (can_edit_group: events_update,
// songs_insert and guard_song_update's editor-only columns); approve / reject / clear /
// reject a song = an approver (can_approve: guard_event_update, guard_song_update).
describe("each kind comes only from someone who could have made that transition", () => {
  const post = (body: Record<string, unknown>) =>
    POST(
      new Request("http://localhost/api/notify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );

  const editorKinds = [
    { kind: "event_submitted", body: { eventId: "ev-1" }, eventStatus: "pending_review", songStatus: "pending" },
    { kind: "song_pending", body: { songId: "song-1" }, eventStatus: "pending_review", songStatus: "pending" },
    { kind: "song_resubmitted", body: { songId: "song-1" }, eventStatus: "pending_review", songStatus: "pending" },
  ];
  const approverKinds = [
    { kind: "event_approved", body: { eventId: "ev-1" }, eventStatus: "approved", songStatus: "pending" },
    { kind: "event_rejected", body: { eventId: "ev-1" }, eventStatus: "rejected", songStatus: "pending" },
    { kind: "song_cleared", body: { songId: "song-1" }, eventStatus: "approved", songStatus: "cleared" },
    { kind: "song_rejected", body: { songId: "song-1" }, eventStatus: "approved", songStatus: "rejected" },
  ];
  /** recipients exist for every audience: approvers, admins and the band's Ar */
  const everyone = () => {
    h.members = [ADMIN, STAFF_A];
    h.groupRoles = [{ user_id: "ar-1", group_id: "band-1" }];
  };

  it.each(editorKinds)("$kind from someone who cannot edit the band is refused, nothing written", async (c) => {
    everyone();
    h.eventStatus = c.eventStatus;
    h.songStatus = c.songStatus;
    h.canEdit = false;
    const res = await post({ kind: c.kind, ...c.body });
    expect(res.status).toBe(403);
    expect(h.inserted).toEqual([]);
    expect(h.editAsked).toEqual([{ gid: "band-1" }]); // the subject's band, not one from the body
  });

  it.each(editorKinds)("$kind from an editor of the band still goes out", async (c) => {
    everyone();
    h.eventStatus = c.eventStatus;
    h.songStatus = c.songStatus;
    h.canApprove = false; // an Ar: edits the band, approves nothing
    await send({ kind: c.kind, ...c.body });
    expect(h.inserted.length).toBeGreaterThan(0);
  });

  it.each(approverKinds)("$kind from someone who cannot approve is refused, nothing written", async (c) => {
    everyone();
    h.eventStatus = c.eventStatus;
    h.songStatus = c.songStatus;
    h.canApprove = false;
    const res = await post({ kind: c.kind, ...c.body });
    expect(res.status).toBe(403);
    expect(h.inserted).toEqual([]);
    expect(h.approveAsked).toEqual([{ tid: "tenant-1" }]);
  });

  it.each(approverKinds)("$kind from an approver still reaches the band's Ar", async (c) => {
    everyone();
    h.eventStatus = c.eventStatus;
    h.songStatus = c.songStatus;
    h.canEdit = false; // label_staff: approves, edits no band
    await send({ kind: c.kind, ...c.body });
    expect(h.inserted.map((r) => r.user_id)).toEqual(["ar-1"]);
  });
});
