// The draft → pending_review auto-send runs whenever an editor merely OPENS a show.
// On 2026-09-28 members' own mic numbers started counting towards completeness
// (lib/completeness.ts performersHaveMics), which made every one of Seishin
// Kakumei's past drafts "complete" at once. Without the guard pinned here, the Ar
// scrolling back through last month would have sent twenty approval requests for
// shows that are over — and pinged the approvers for each.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { CompletenessResult } from "@/lib/completeness";
import type { EventRow, Group } from "@/lib/types";
import { bkkTodayKey } from "@/lib/time";

const writes = vi.hoisted(() => ({ updates: [] as unknown[], notified: [] as string[] }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const b = {
        update: (v: unknown) => (writes.updates.push(v), b),
        eq: () => b,
        select: () => Promise.resolve({ data: [{ id: "e1" }], error: null }),
      };
      return b;
    },
  }),
}));
vi.mock("@/lib/notify-client", () => ({
  notify: (type: string) => writes.notified.push(type),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/events/e1",
  useSearchParams: () => new URLSearchParams(),
}));

import { EventWorkspace } from "./event-workspace";

const group = { id: "g1", tenant_id: "t1", name: "Seishin Kakumei" } as Group;
const complete = { complete: true, missing: [] } as unknown as CompletenessResult;

const plusDays = (n: number) => {
  const d = new Date(`${bkkTodayKey()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const mount = (event_date: string) =>
  render(
    <EventWorkspace
      event={
        {
          id: "e1",
          tenant_id: "t1",
          group_id: "g1",
          name: "Show",
          event_date,
          status: "draft",
          event_type: "idol",
          is_template: false,
          group,
        } as unknown as EventRow & { group: Group | null }
      }
      eventId="e1"
      tenantId="t1"
      editable
      completeness={complete}
      eventType="idol"
      showStartTime={null}
      hardOutTime={null}
      schedule={[]}
      setlist={[]}
      micMap={[]}
      members={[]}
      songs={[]}
      lineup={[]}
    />
  );

beforeEach(() => {
  writes.updates = [];
  writes.notified = [];
});

describe("EventWorkspace · auto-send for approval", () => {
  it("sends a complete UPCOMING show and tells the approvers", async () => {
    mount(plusDays(3));
    await waitFor(() => expect(writes.updates).toEqual([{ status: "pending_review" }]));
    await waitFor(() => expect(writes.notified).toEqual(["event_submitted"]));
  });

  it("sends a complete show on its own day", async () => {
    mount(plusDays(0));
    await waitFor(() => expect(writes.updates).toEqual([{ status: "pending_review" }]));
  });

  it("does NOT send a complete show that has already happened", async () => {
    mount(plusDays(-1));
    await new Promise((r) => setTimeout(r, 50));
    expect(writes.updates).toEqual([]);
    expect(writes.notified).toEqual([]);
  });
});
