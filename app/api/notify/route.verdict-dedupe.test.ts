// ---------------------------------------------------------------------------
// THE NEWEST VERDICT IN THE AR'S BELL IS THE SHOW'S REAL ONE.
//
// 2026-10-27 (hunt 8): the 5-minute dedupe (step 4b) was per kind. An approver who
// pressed อนุมัติ → ปฏิเสธ (a misclick) → อนุมัติ inside the window, before the Ar opened
// the bell, sent the Ar ✅ then ↩️ - and the third press nothing at all, row or push,
// because the Ar "still had an unread event_approved". Their newest row and their last
// push said "งานถูกตีกลับ" on an approved show. The same for song_rejected / song_cleared.
// A verdict is now read against its opposite: only the recipient's newest row of the
// family can hold them back, and only when it already says the same thing.
//
// Runs the real POST handler against a fake service-role client whose `notifications`
// table keeps what was inserted, so the dedupe reads back the rows earlier calls wrote.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  eventStatus: "approved",
  songStatus: "cleared",
  notifications: [] as Row[],
  tick: 0,
  pushedTo: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "approver" } } }) },
    rpc: async () => ({ data: true, error: null }),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  hasServiceRole: () => true,
  createAdminClient: () => ({ from: (t: string) => table(t) }),
}));
vi.mock("@/lib/push", () => ({
  vapidConfigured: () => true,
  sendPush: vi.fn(async (sub: { endpoint: string }) => {
    h.pushedTo.push(sub.endpoint);
    return "ok";
  }),
  PUSH_TTL_SECONDS: { live: 1, reminder: 1, default: 1 },
}));

/** A chainable, awaitable stand-in for one PostgREST query; eq / in filters apply. */
function table(name: string) {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  const q: Record<string, unknown> = {};
  for (const m of ["gt", "is", "or", "limit", "order", "select"]) q[m] = () => q;
  q.eq = (c: string, v: unknown) => {
    eqs.push([c, v]);
    return q;
  };
  q.in = (c: string, vs: unknown[]) => {
    ins.push([c, vs]);
    return q;
  };
  q.maybeSingle = async () => {
    if (name === "events")
      return {
        data: { id: "ev-1", name: "Show", group_id: "band-1", tenant_id: "t-1", status: h.eventStatus, groups: { name: "Band" } },
        error: null,
      };
    if (name === "songs")
      return {
        data: { id: "song-1", title: "Plus One", group_id: "band-1", tenant_id: "t-1", copyright_status: h.songStatus, groups: { name: "Band" } },
        error: null,
      };
    if (name === "tenant_members") return { data: { user_id: "approver" }, error: null };
    return { data: null, error: null };
  };
  q.insert = async (rows: Row[]) => {
    // one second apart, as ISO strings - the shape PostgREST answers with
    for (const r of rows)
      h.notifications.push({ ...r, created_at: new Date(Date.UTC(2026, 9, 27, 12, 0, ++h.tick)).toISOString(), read_at: null });
    return { error: null };
  };
  q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
    let data: Row[] = [];
    if (name === "group_roles") data = [{ user_id: "ar-1" }];
    if (name === "push_subscriptions") data = [{ id: "sub-1", user_id: "ar-1", endpoint: "ar-phone", p256dh: "k", auth: "a" }];
    if (name === "notifications") {
      const value = (n: Row, c: string) => {
        const m = /^meta->>(.+)$/.exec(c);
        return m ? (n.meta as Row)[m[1]] : n[c];
      };
      data = h.notifications.filter(
        (n) => eqs.every(([c, v]) => value(n, c) === v) && ins.every(([c, vs]) => vs.includes(value(n, c)))
      );
    }
    return Promise.resolve({ data, error: null }).then(ok, bad);
  };
  return q;
}

import { POST } from "./route";

async function send(kind: string, body: Record<string, unknown>) {
  const res = await POST(
    new Request("http://localhost/api/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, ...body }),
    })
  );
  expect(res.status).toBe(200);
}
const eventVerdict = (kind: "event_approved" | "event_rejected") => {
  h.eventStatus = kind === "event_approved" ? "approved" : "rejected";
  return send(kind, { eventId: "ev-1" });
};
const songVerdict = (kind: "song_cleared" | "song_rejected") => {
  h.songStatus = kind === "song_cleared" ? "cleared" : "rejected";
  return send(kind, { songId: "song-1" });
};
const arRowsNewestFirst = () =>
  h.notifications
    .filter((n) => n.user_id === "ar-1")
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

beforeEach(() => {
  h.notifications = [];
  h.tick = 0;
  h.pushedTo = [];
});

describe("a verdict is deduped against its opposite, not only its own kind", () => {
  it("approve → reject → approve: the Ar's newest row and last push say approved", async () => {
    await eventVerdict("event_approved");
    await eventVerdict("event_rejected");
    await eventVerdict("event_approved");
    expect(arRowsNewestFirst()[0].type).toBe("event_approved");
    expect(h.pushedTo).toHaveLength(3);
  });

  it("reject → approve → reject: the newest row says rejected", async () => {
    await eventVerdict("event_rejected");
    await eventVerdict("event_approved");
    await eventVerdict("event_rejected");
    expect(arRowsNewestFirst()[0].type).toBe("event_rejected");
  });

  it("songs: rejected → cleared → rejected ends on rejected", async () => {
    await songVerdict("song_rejected");
    await songVerdict("song_cleared");
    await songVerdict("song_rejected");
    expect(arRowsNewestFirst()[0].type).toBe("song_rejected");
  });

  it("the same verdict twice is still told once (row and push)", async () => {
    await eventVerdict("event_approved");
    await eventVerdict("event_approved");
    expect(arRowsNewestFirst().map((n) => n.type)).toEqual(["event_approved"]);
    expect(h.pushedTo).toHaveLength(1);
  });

  it("the same verdict again after the first was READ: a new row, but no second push", async () => {
    await eventVerdict("event_approved");
    h.notifications[0].read_at = "2026-10-27T12:00:30.000Z";
    await eventVerdict("event_approved");
    expect(arRowsNewestFirst()).toHaveLength(2);
    expect(h.pushedTo).toHaveLength(1);
  });
});
