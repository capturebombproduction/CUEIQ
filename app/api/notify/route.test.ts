// ---------------------------------------------------------------------------
// song_pending MUST OPEN SOMETHING FOR EACH PERSON IT GOES TO (CQ-37).
//
// "🎵 เพลงใหม่รอตรวจลิขสิทธิ์" goes to every approver — admin AND label_staff — and used to
// carry ONE link, "/library". canViewLibrary is false for label_staff, so
// app/(app)/library/page.tsx redirects them to /dashboard, which lands on /overview: a
// tap on the bell or the push reloaded the page they were already on, with nothing there
// to say which song. Admin keeps /library; staff get an event that uses the song (the
// event page opens read-only for them and carries the approver's copyright triage), and
// /overview when no event does.
//
// This runs the real POST handler against a fake service-role client, so it traces from
// the request to the `notifications` rows — the same rows the bell and the push read.
// lib/notify-link-routes.test.ts separately holds every destination to a real page in
// both apps.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { canViewLibrary, makePerms } from "@/lib/permissions";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  /** setlist_items rows (with the embedded event date) that use the song. */
  uses: [] as Row[],
  /** what the approvers query returns */
  approvers: [] as Row[],
  inserted: [] as Row[],
  queried: [] as string[],
  /** what the setlist_items lookup asked for: its select string and every .eq() */
  setlistSelect: "",
  setlistEqs: [] as [string, unknown][],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "caller" } } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  hasServiceRole: () => true,
  createAdminClient: () => ({ from: (t: string) => table(t) }),
}));
vi.mock("@/lib/push", () => ({ vapidConfigured: () => false, sendPush: vi.fn() }));

/** A chainable, awaitable stand-in for one PostgREST query. */
function table(name: string) {
  h.queried.push(name);
  const single = (): Row | null => {
    if (name === "songs")
      return {
        id: "song-1",
        title: "Plus One",
        group_id: "band-1",
        tenant_id: "tenant-1",
        copyright_status: "pending",
        groups: { name: "Seishin Kakumei" },
      };
    if (name === "tenant_members") return { user_id: "caller" }; // the caller belongs
    return null;
  };
  const many = (): Row[] => {
    if (name === "tenant_members") return h.approvers;
    if (name === "setlist_items") return h.uses;
    return []; // notifications (dedupe), push_subscriptions, …
  };
  const q: Record<string, unknown> = {};
  for (const m of ["in", "gt", "is", "or", "limit", "order"]) q[m] = () => q;
  q.select = (cols: string) => {
    if (name === "setlist_items") h.setlistSelect = cols;
    return q;
  };
  q.eq = (col: string, val: unknown) => {
    if (name === "setlist_items") h.setlistEqs.push([col, val]);
    return q;
  };
  q.maybeSingle = async () => ({ data: single(), error: null });
  q.single = async () => ({ data: single(), error: null });
  q.insert = async (rows: Row | Row[]) => {
    if (name === "notifications") h.inserted.push(...(Array.isArray(rows) ? rows : [rows]));
    return { error: null };
  };
  q.delete = () => q;
  q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
    Promise.resolve({ data: many(), error: null }).then(ok, bad);
  return q;
}

import { POST } from "./route";

const ADMIN = { user_id: "admin-1", role: "admin" };
const STAFF_A = { user_id: "staff-a", role: "label_staff" };
const STAFF_B = { user_id: "staff-b", role: "label_staff" };

const use = (event_id: string, event_date: string | null, is_template = false): Row => ({
  event_id,
  events: event_date === null ? null : { event_date, is_template },
});

async function sendSongPending() {
  const res = await POST(
    new Request("http://localhost/api/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "song_pending", songId: "song-1" }),
    })
  );
  expect(res.status).toBe(200);
  return Object.fromEntries(h.inserted.map((r) => [r.user_id as string, r.link as string]));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T05:00:00Z")); // 12:00 in Bangkok
  h.uses = [];
  h.approvers = [ADMIN, STAFF_A, STAFF_B];
  h.inserted = [];
  h.queried = [];
  h.setlistSelect = "";
  h.setlistEqs = [];
});
afterEach(() => vi.useRealTimers());

describe("song_pending resolves its link per recipient (CQ-37)", () => {
  it("admin keeps the library; label staff get a show that uses the song", async () => {
    h.uses = [use("ev-late", "2026-12-01"), use("ev-soon", "2026-10-05")];
    const links = await sendSongPending();
    expect(links["admin-1"]).toBe("/library");
    expect(links["staff-a"]).toBe("/events/ev-soon");
    expect(links["staff-b"]).toBe("/events/ev-soon");
  });

  it("falls back to /overview for staff when no show uses the song — never a dead link", async () => {
    h.uses = [];
    const links = await sendSongPending();
    expect(links["admin-1"]).toBe("/library");
    expect(links["staff-a"]).toBe("/overview");
  });

  it("never sends anyone to /library who cannot open it", async () => {
    h.uses = [use("ev-soon", "2026-10-05")];
    const links = await sendSongPending();
    // The invariant, from the permission rule itself rather than from a hard-coded role.
    expect(canViewLibrary(makePerms("label_staff"))).toBe(false);
    expect(canViewLibrary(makePerms("admin"))).toBe(true);
    expect(links["staff-a"]).not.toBe("/library");
    expect(links["admin-1"]).toBe("/library");
  });

  it("opens the soonest show still ahead, not the earliest one in the table", async () => {
    h.uses = [use("ev-old", "2026-09-01"), use("ev-late", "2026-12-01"), use("ev-soon", "2026-10-05")];
    expect((await sendSongPending())["staff-a"]).toBe("/events/ev-soon");
  });

  it("with every show already past, opens the most recent one", async () => {
    h.uses = [use("ev-old", "2026-08-01"), use("ev-recent", "2026-09-20")];
    expect((await sendSongPending())["staff-a"]).toBe("/events/ev-recent");
  });

  it("an undated show is still better than none", async () => {
    h.uses = [use("ev-tbd", null)];
    expect((await sendSongPending())["staff-a"]).toBe("/events/ev-tbd");
  });

  it("never opens a 「แม่แบบ」 template, even when it is the soonest row", async () => {
    h.uses = [use("tpl", "2026-10-03", true), use("ev-real", "2026-10-20")];
    expect((await sendSongPending())["staff-a"]).toBe("/events/ev-real");
  });

  it("a song that sits only on a template sends staff to /overview, not to the template", async () => {
    h.uses = [use("tpl", "2026-10-03", true)];
    expect((await sendSongPending())["staff-a"]).toBe("/overview");
  });

  it("asks the database to leave templates out, as the Overview and the dashboard do", async () => {
    await sendSongPending();
    expect(h.setlistSelect).toMatch(/events!inner\(.*is_template.*\)/);
    expect(h.setlistEqs).toContainEqual(["events.is_template", false]);
  });

  it("does not look the song's shows up when no label staff is among the recipients", async () => {
    h.approvers = [ADMIN];
    h.uses = [use("ev-soon", "2026-10-05")];
    const links = await sendSongPending();
    expect(links["admin-1"]).toBe("/library");
    expect(h.queried).not.toContain("setlist_items");
  });
});
