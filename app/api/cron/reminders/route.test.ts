// ---------------------------------------------------------------------------
// THE DAILY REMINDER RUN NEVER READS A FAILURE AS "NOTHING TO DO".
//
// Every read in runReminders used to coalesce a failed answer to an empty list
// (`data ?? []`): a broken shows query was a quiet morning, a broken band-roles read
// was a band with nobody in it, and the run answered ok:true — so the band got no
// "📅 โชว์วันนี้" and the Dev Inbox, the one place a cron failure is supposed to land
// (lib/cron-report.ts), stayed empty. The dedupe read was worse: failed, it looked
// like "nobody has been told yet" and the whole band got the same push twice.
//
// Runs the real GET handler against a fake service-role client, from the request to
// the `notifications` rows the bell and the push read.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;
type Answer = { data: unknown; error: { message: string } | null };
type Call = [string, unknown[]];

const h = vi.hoisted(() => ({
  /** answers a table read, given every builder call made on it */
  answer: (() => ({ data: [], error: null })) as (table: string, calls: [string, unknown[]][]) => {
    data: unknown;
    error: { message: string } | null;
  },
  insertError: null as { message: string } | null,
  inserted: [] as Record<string, unknown>[],
  pushedTo: [] as string[][],
  reports: [] as unknown[][],
}));

vi.mock("@/lib/supabase/admin", () => ({
  hasServiceRole: () => true,
  createAdminClient: () => ({ from: (t: string) => table(t) }),
}));
vi.mock("@/lib/notify-server", () => ({
  pushToUsers: async (_admin: unknown, ids: string[]) => {
    h.pushedTo.push(ids);
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

/** A chainable, awaitable stand-in for one PostgREST query. */
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
    if (h.insertError) return { error: h.insertError };
    if (name === "notifications") h.inserted.push(...(Array.isArray(rows) ? rows : [rows]));
    return { error: null };
  };
  q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
    Promise.resolve(h.answer(name, calls)).then(ok, bad);
  return q;
}

const has = (calls: Call[], method: string, ...args: unknown[]) =>
  calls.some(([m, a]) => m === method && args.every((v, i) => a[i] === v));

const TODAY = "2026-10-24";
const SHOW = (id: string, group: string, name: string) => ({
  id,
  name,
  group_id: group,
  tenant_id: "tenant-1",
  event_date: TODAY,
  show_start_time: "19:00",
  groups: { name },
});
const BAND_ROLES: Record<string, Row[]> = {
  "band-a": [{ user_id: "a-ar" }, { user_id: "a-mem" }],
  "band-b": [{ user_id: "b-ar" }],
};

/** The default world: two bands with a show today, nobody told yet, nothing else due. */
function world(over: Partial<Record<string, (calls: Call[]) => Answer | undefined>> = {}) {
  h.answer = (name, calls) => {
    const custom = over[name]?.(calls);
    if (custom) return custom;
    if (name === "events") {
      // only block 1 (shows today/tomorrow) has rows by default
      if (has(calls, "lte", "event_date", "2026-10-25"))
        return { data: [SHOW("ev-a", "band-a", "Band A"), SHOW("ev-b", "band-b", "Band B")], error: null };
      return { data: [], error: null };
    }
    if (name === "group_roles") {
      const g = calls.find(([m, a]) => m === "eq" && a[0] === "group_id")?.[1][1] as string;
      return { data: BAND_ROLES[g] ?? [], error: null };
    }
    return { data: [], error: null }; // notifications (dedupe), schedule_items, tenant_members
  };
}

const run = async () => {
  const { GET } = await import("./route");
  return GET(new Request("http://x/api/cron/reminders", { headers: { authorization: "Bearer s3cret" } }));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T01:00:00Z`)); // the cron's own hour (vercel.json)
  process.env.CRON_SECRET = "s3cret";
  h.insertError = null;
  h.inserted = [];
  h.pushedTo = [];
  h.reports = [];
  world();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("reminder cron: a failure is reported, never read as nothing to do", () => {
  it("baseline: every band with a show today is reminded, once", async () => {
    const res = await run();
    expect(res.status).toBe(200);
    expect(h.inserted.map((r) => r.user_id).sort()).toEqual(["a-ar", "a-mem", "b-ar"]);
    expect(h.inserted.every((r) => r.type === "event_reminder")).toBe(true);
    expect(h.reports).toEqual([]);
  });

  it("a failed dedupe read sends nothing for that show — never a second push to the whole band", async () => {
    world({
      notifications: (calls) =>
        has(calls, "eq", "meta->>event_id", "ev-a")
          ? { data: null, error: { message: "canceling statement due to statement timeout" } }
          : undefined,
    });
    const res = await run();
    expect(h.inserted.some((r) => (r.meta as Row).event_id === "ev-a")).toBe(false);
    expect(h.pushedTo.flat()).not.toContain("a-ar");
    // the other band's reminder still goes out
    expect(h.inserted.map((r) => r.user_id)).toEqual(["b-ar"]);
    expect(res.status).toBe(500);
    expect(String(h.reports[0]?.[1])).toContain("statement timeout");
  });

  it("one band's failed roles read costs only that band, and the run says so", async () => {
    world({
      group_roles: (calls) =>
        has(calls, "eq", "group_id", "band-a") ? { data: null, error: { message: "JWT expired" } } : undefined,
    });
    const res = await run();
    expect(h.inserted.map((r) => r.user_id)).toEqual(["b-ar"]);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.failures.join(" ")).toContain("JWT expired");
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0][0]).toBe("reminders");
  });

  it("a failed shows query is a failed run, not a quiet morning", async () => {
    world({
      events: (calls) =>
        has(calls, "lte", "event_date", "2026-10-25")
          ? { data: null, error: { message: 'column events.show_start_time does not exist' } }
          : undefined,
    });
    const res = await run();
    expect(res.status).toBe(500);
    expect(h.inserted).toEqual([]);
    expect(String(h.reports[0]?.[1])).toContain("show_start_time");
  });

  it("a failed insert is reported and not pushed", async () => {
    h.insertError = { message: "insert or update on table notifications violates foreign key" };
    const res = await run();
    expect(h.pushedTo).toEqual([]);
    expect(res.status).toBe(500);
    expect(h.reports).toHaveLength(1);
  });

  it("a failed approvers read is reported (the waiting submission is not silently dropped)", async () => {
    world({
      events: (calls) =>
        has(calls, "eq", "status", "pending_review")
          ? {
              data: [
                {
                  id: "ev-p",
                  name: "Waiting show",
                  group_id: "band-a",
                  tenant_id: "tenant-1",
                  event_date: "2026-10-30",
                  status: "pending_review",
                  updated_at: "2026-10-20T00:00:00Z",
                  groups: { name: "Band A" },
                },
              ],
              error: null,
            }
          : has(calls, "lte", "event_date", "2026-10-25")
            ? { data: [], error: null }
            : undefined,
      tenant_members: () => ({ data: null, error: { message: "permission denied for table tenant_members" } }),
    });
    const res = await run();
    expect(res.status).toBe(500);
    expect(String(h.reports[0]?.[1])).toContain("tenant_members");
  });

  it("a band exempt from deadlines is not told about one", async () => {
    const due = (id: string, group: string, exempt: boolean) => ({
      id,
      name: `Show ${id}`,
      group_id: group,
      tenant_id: "tenant-1",
      deadline: "2026-10-25T10:00:00Z",
      status: "draft",
      groups: { name: group, exempt_from_deadline: exempt },
    });
    world({
      events: (calls) =>
        has(calls, "not", "deadline", "is", null)
          ? { data: [due("ev-x", "band-a", true), due("ev-y", "band-b", false)], error: null }
          : has(calls, "lte", "event_date", "2026-10-25")
            ? { data: [], error: null }
            : undefined,
    });
    const res = await run();
    expect(res.status).toBe(200);
    const deadline = h.inserted.filter((r) => r.type === "event_deadline");
    expect(deadline.map((r) => (r.meta as Row).event_id)).toEqual(["ev-y"]);
  });
});
