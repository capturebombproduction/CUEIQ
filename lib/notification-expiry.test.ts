import { describe, it, expect } from "vitest";
import { expireSupersededDailyNotifications } from "./notification-expiry";

type Row = { id: string; type: string; read_at: string | null; created_at: string };

/** An in-memory notifications table behind just the builder calls the expiry
 *  makes — so the test asserts which ROWS changed, not the shape of a query. */
function table(rows: Row[]) {
  const client = {
    from: () => {
      const filters: ((r: Row) => boolean)[] = [];
      let patch: Partial<Row> = {};
      const b = {
        update: (p: Partial<Row>) => ((patch = p), b),
        in: (k: keyof Row, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
        is: (k: keyof Row, v: null) => (filters.push((r) => r[k] === v), b),
        lt: (k: keyof Row, v: string) => (filters.push((r) => String(r[k]) < v), b),
        select: () => b,
        then: (res: (v: unknown) => unknown) => {
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          for (const r of hit) Object.assign(r, patch);
          return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(res);
        },
      };
      return b;
    },
  };
  return client as never;
}

const RUN = "2026-09-28T01:00:00.000Z";
const WINDOW = "2026-09-27T05:00:00.000Z"; // the run's dedupe window start (−20h)

describe("expireSupersededDailyNotifications", () => {
  it("clears yesterday's daily rows, leaves today's, other kinds, and anything already read", async () => {
    const rows: Row[] = [
      { id: "old-show", type: "event_reminder", read_at: null, created_at: "2026-09-26T01:00:00Z" },
      { id: "old-deadline", type: "event_deadline", read_at: null, created_at: "2026-09-26T01:00:00Z" },
      { id: "old-nag", type: "event_awaiting_approval", read_at: null, created_at: "2026-09-27T01:00:00Z" },
      { id: "today-show", type: "event_reminder", read_at: null, created_at: "2026-09-28T01:00:00Z" },
      { id: "reply", type: "feedback_reply", read_at: null, created_at: "2026-09-01T01:00:00Z" },
      { id: "submitted", type: "event_submitted", read_at: null, created_at: "2026-09-01T01:00:00Z" },
      { id: "seen", type: "event_reminder", read_at: "2026-09-26T09:00:00Z", created_at: "2026-09-26T01:00:00Z" },
    ];
    const n = await expireSupersededDailyNotifications(table(rows), { before: WINDOW, now: RUN });
    const state = Object.fromEntries(rows.map((r) => [r.id, r.read_at]));

    expect(n).toBe(3);
    expect(state).toEqual({
      "old-show": RUN,
      "old-deadline": RUN,
      "old-nag": RUN,
      "today-show": null, // this run's own reminder still counts
      reply: null, // a reply to their feedback is exactly what must stay visible
      submitted: null,
      seen: "2026-09-26T09:00:00Z", // an existing read time is not rewritten
    });
  });
});
