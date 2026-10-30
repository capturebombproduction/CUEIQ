// ---------------------------------------------------------------------------
// WHICH MORNING TELLS A BAND ABOUT ITS SHOW, AND IN WHICH WORD.
//
// 2026-10-30, hunt 11: block 1 said "วันนี้" / "พรุ่งนี้" by event_date alone. A show
// called the evening BEFORE its date (a 00:30 stage, called at 22:30) got "📅 โชว์พรุ่งนี้
// — นัด 22:30" on the morning of a call that was that same night - a member who believed
// it came a day late - and "📅 โชว์วันนี้" on its date, hours after the show was over.
// The day that counts is the day of the CALL (lib/next-show.ts callDayOffset): such a show
// is "พรุ่งนี้" the morning before its call, "คืนนี้" on the call's day, and nothing on its
// date. Every ordinary show - both real shows of 10-31 and 11-01 among them - is told
// exactly what it was told before.
//
// Runs the real GET handler against a fake service-role client (route.test.ts's harness).
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;
type Call = [string, unknown[]];

const h = vi.hoisted(() => ({
  shows: [] as Record<string, unknown>[],
  schedule: [] as Record<string, unknown>[],
  inserted: [] as Record<string, unknown>[],
  pushed: [] as { ids: string[]; title: string; body: string }[],
  reports: [] as unknown[][],
}));

vi.mock("@/lib/supabase/admin", () => ({
  hasServiceRole: () => true,
  createAdminClient: () => ({ from: (t: string) => table(t) }),
}));
vi.mock("@/lib/notify-server", () => ({
  pushToUsers: async (_admin: unknown, ids: string[], msg: { title: string; body: string }) => {
    h.pushed.push({ ids, title: msg.title, body: msg.body });
    return ids.length;
  },
}));
vi.mock("@/lib/notification-expiry", () => ({
  expireSupersededDailyNotifications: async () => 0,
}));
vi.mock("@/lib/cron-report", async (orig) => ({
  ...(await orig<typeof import("@/lib/cron-report")>()),
  reportCronFailure: async (...args: unknown[]) => {
    h.reports.push(args);
  },
}));

const arg = (calls: Call[], method: string, col: string) =>
  calls.find(([m, a]) => m === method && a[0] === col)?.[1][1];

/** Block 1's reads answer from h.shows by their event_date filters; the deadline and
 *  approval blocks (and the dedupe read) find nothing. */
function answer(name: string, calls: Call[]): { data: unknown; error: null } {
  if (name === "events") {
    if (calls.some(([m, a]) => m === "not" && a[0] === "deadline")) return { data: [], error: null };
    if (arg(calls, "eq", "status") !== undefined) return { data: [], error: null };
    const eq = arg(calls, "eq", "event_date") as string | undefined;
    const gte = arg(calls, "gte", "event_date") as string | undefined;
    const lte = arg(calls, "lte", "event_date") as string | undefined;
    const rows = h.shows.filter((s) => {
      const d = s.event_date as string;
      if (eq !== undefined) return d === eq;
      return (gte === undefined || d >= gte) && (lte === undefined || d <= lte);
    });
    return { data: rows, error: null };
  }
  if (name === "schedule_items") {
    const ids = (calls.find(([m, a]) => m === "in" && a[0] === "event_id")?.[1][1] ?? []) as string[];
    return { data: h.schedule.filter((r) => ids.includes(r.event_id as string)), error: null };
  }
  if (name === "group_roles") return { data: [{ user_id: "mem-1" }], error: null };
  return { data: [], error: null };
}

function table(name: string) {
  const calls: Call[] = [];
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gt", "gte", "lte", "lt", "not", "neq", "in", "is", "order", "limit"]) {
    q[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return q;
    };
  }
  q.insert = async (rows: Row | Row[]) => {
    if (name === "notifications") h.inserted.push(...(Array.isArray(rows) ? rows : [rows]));
    return { error: null };
  };
  q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
    Promise.resolve(answer(name, calls)).then(ok, bad);
  return q;
}

const show = (id: string, name: string, event_date: string, show_start_time: string) => ({
  id,
  name,
  group_id: "seishin",
  tenant_id: "tenant-1",
  event_date,
  show_start_time,
  groups: { name: "Seishin Kakumei" },
});

/** The run of the morning of `bkkDay` (01:00 UTC = 08:00 in Bangkok, vercel.json). */
async function runOn(bkkDay: string) {
  vi.setSystemTime(new Date(`${bkkDay}T01:00:00Z`));
  h.inserted = [];
  h.pushed = [];
  const { GET } = await import("./route");
  const res = await GET(
    new Request("http://x/api/cron/reminders", { headers: { authorization: "Bearer s3cret" } })
  );
  expect(res.status).toBe(200);
  return h.pushed.map((p) => `${p.title} | ${p.body}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  process.env.CRON_SECRET = "s3cret";
  h.reports = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("reminder cron: the day word is the day of the call", () => {
  it("the real shows of 10-31 (17:40, call 17:25) and 11-01 (13:40, call 13:25) are told as before", async () => {
    h.shows = [
      show("halloween", "Ichiban idol vol.26 Halloween", "2026-10-31", "17:40:00"),
      show("reborn", "Reborn into into a new me", "2026-11-01", "13:40:00"),
    ];
    h.schedule = [
      { event_id: "halloween", start_time: "17:25:00", kind: "call" },
      { event_id: "halloween", start_time: "17:40:00", kind: "stage" },
      { event_id: "reborn", start_time: "13:25:00", kind: "call" },
      { event_id: "reborn", start_time: "13:40:00", kind: "stage" },
    ];
    expect(await runOn("2026-10-30")).toEqual([
      "📅 โชว์พรุ่งนี้ | Ichiban idol vol.26 Halloween · Seishin Kakumei — นัด 17:25 · ขึ้นเวที 17:40",
    ]);
    expect(await runOn("2026-10-31")).toEqual([
      "📅 โชว์วันนี้ | Ichiban idol vol.26 Halloween · Seishin Kakumei — นัด 17:25 · ขึ้นเวที 17:40",
      "📅 โชว์พรุ่งนี้ | Reborn into into a new me · Seishin Kakumei — นัด 13:25 · ขึ้นเวที 13:40",
    ]);
    expect(await runOn("2026-11-01")).toEqual([
      "📅 โชว์วันนี้ | Reborn into into a new me · Seishin Kakumei — นัด 13:25 · ขึ้นเวที 13:40",
    ]);
    expect(h.reports).toEqual([]);
  });

  it("a 00:30 show on Jan 1 called at 22:30 on Dec 31: 'พรุ่งนี้' on Dec 30, 'คืนนี้' on Dec 31, nothing on Jan 1", async () => {
    h.shows = [show("nye", "Countdown Afterparty", "2027-01-01", "00:30:00")];
    h.schedule = [
      { event_id: "nye", start_time: "22:30:00", kind: "call" },
      { event_id: "nye", start_time: "00:30:00", kind: "stage" },
    ];
    const body = "Countdown Afterparty · Seishin Kakumei — นัด 22:30 · ขึ้นเวที 00:30";
    expect(await runOn("2026-12-30")).toEqual([`📅 โชว์พรุ่งนี้ | ${body}`]);
    expect(await runOn("2026-12-31")).toEqual([`📅 โชว์คืนนี้ | ${body}`]);
    expect(await runOn("2027-01-01")).toEqual([]);
    expect(await runOn("2026-12-29")).toEqual([]);
    expect(h.reports).toEqual([]);
  });

  it("a late show whose call and stage are both before midnight is told by its date, as before", async () => {
    h.shows = [show("late", "Late Live", "2026-12-31", "23:40:00")];
    h.schedule = [{ event_id: "late", start_time: "21:40:00", kind: "call" }];
    expect(await runOn("2026-12-30")).toEqual(["📅 โชว์พรุ่งนี้ | Late Live · Seishin Kakumei — นัด 21:40 · ขึ้นเวที 23:40"]);
    expect(await runOn("2026-12-31")).toEqual(["📅 โชว์วันนี้ | Late Live · Seishin Kakumei — นัด 21:40 · ขึ้นเวที 23:40"]);
  });
});
