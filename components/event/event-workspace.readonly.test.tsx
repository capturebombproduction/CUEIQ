// "แก้ไขตารางเวลาไม่ได้" — reported as a BUG through the in-app channel on
// 2026-06-27 by a Label Staff account, and it is not one: a band's call sheet is
// edited by that band's Ar and by admins, while label-wide staff review and
// approve (lib/permissions.ts's canEditGroup). พี่ confirmed the rule stands
// (2026-08-16) and asked for the missing half — the app saying so.
//
// A disabled field with no explanation is indistinguishable from a broken page,
// and the person who hits it cannot tell which one they are looking at. That is
// what this test protects: not the permission (lib/permissions.test.ts owns
// that), but the sentence.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CompletenessResult } from "@/lib/completeness";
import type { EventRow, Group } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/events/x",
  useSearchParams: () => new URLSearchParams(),
}));

import { EventWorkspace } from "./event-workspace";

const group: Group = {
  id: "g1",
  tenant_id: "t1",
  name: "วงทดสอบ",
  color: null,
  skin: null,
  exempt_from_deadline: false,
  self_photo: false,
  contact_name: null,
  contact_phone: null,
  created_at: "2026-01-01T00:00:00.000Z",
} as Group;

const event = {
  id: "e1",
  tenant_id: "t1",
  group_id: "g1",
  name: "งานทดสอบ",
  event_date: "2026-12-01",
  venue: null,
  event_type: "idol",
  show_start_time: null,
  hard_out_time: null,
  status: "in_progress",
  notes: null,
  map_url: null,
  costume_theme: null,
  share_token: null,
  share_expires_at: null,
  deadline: null,
  deadline_note: null,
  last_run_seconds: null,
  last_run_at: null,
  is_template: false,
  is_practice: false,
  created_by: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  group,
} as unknown as EventRow & { group: Group | null };

const completeness = { complete: false, missing: [], required: [] } as unknown as CompletenessResult;

const mount = (editable: boolean) =>
  render(
    <EventWorkspace
      event={event}
      eventId="e1"
      tenantId="t1"
      editable={editable}
      completeness={completeness}
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

describe("EventWorkspace · why the page is read-only", () => {
  it("names who CAN edit, instead of leaving the fields dead and silent", () => {
    mount(false);
    const notice = screen.getByTestId("read-only-notice");
    expect(notice).toBeInTheDocument();
    // Structural on the test id, textual on the two words that carry the whole
    // message — a reader who does not know they lack permission learns the role
    // to ask for.
    expect(notice.textContent).toContain("Ar");
    expect(notice.textContent).toContain("แอดมิน");
  });

  it("says nothing at all to someone who CAN edit", () => {
    mount(true);
    expect(screen.queryByTestId("read-only-notice")).not.toBeInTheDocument();
  });
});
