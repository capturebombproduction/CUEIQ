// The run sheet / JPG printed the members' STANDING mic numbers even when this show
// had its own Mic Map.
//
// mic-map-editor.tsx (seedFromStanding) and event-workspace.tsx both state "per-event
// rows win on the Summary, the readiness gate, the Excel sheet and the JPG". The Excel
// did (lib/export-excel.ts micBaseRows prefers mic_assignments) — but EventWorkspace
// never handed `micMap` to <EventSummary>, whose "Lineup & Mics" block printed
// `m.mic_number` per member. An Ar who moved Aya to mic 5 for this show (mic 1 broken /
// a guest on 1) got an Excel that said 5 and a JPG — the sheet that goes to the group
// chat — that said 1.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CompletenessResult } from "@/lib/completeness";
import type { EventRow, Group, Member, MicAssignment } from "@/lib/types";
import { micBaseRows } from "@/lib/export-excel";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/events/e1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/event/setlist-builder", () => ({ SetlistBuilder: () => null }));
vi.mock("@/components/event/schedule-editor", () => ({ ScheduleEditor: () => null }));
vi.mock("@/components/event/mic-map-editor", () => ({ MicMapEditor: () => null }));
vi.mock("@/components/event/lineup-editor", () => ({ LineupEditor: () => null }));

import { EventWorkspace } from "@/components/event/event-workspace";
import { showMicRows } from "@/components/event/event-summary";

const group = { id: "g1", tenant_id: "t1", name: "วงทดสอบ" } as Group;
const event = {
  id: "e1", tenant_id: "t1", group_id: "g1", name: "งานทดสอบ", event_date: "2026-12-01",
  venue: null, event_type: "idol", show_start_time: null, hard_out_time: null, status: "draft",
  notes: null, map_url: null, costume_theme: null, is_template: false, group,
} as unknown as EventRow & { group: Group | null };

const member = (id: string, nickname: string, mic: number | null, sort: number) =>
  ({ id, tenant_id: "t1", group_id: "g1", name: `${nickname} full`, nickname, mic_number: mic,
    color: null, sort_order: sort, created_at: "" }) as Member;
const aya = member("m1", "Aya", 1, 1);
const mic = (id: string, num: number, holder: string, order: number) =>
  ({ id, tenant_id: "t1", event_id: "e1", mic_number: num, holder_name: holder, order_index: order,
    created_at: "" }) as MicAssignment;

function mount(micMap: MicAssignment[], members: Member[] = [aya]) {
  return render(
    <EventWorkspace
      event={event} eventId="e1" tenantId="t1" editable={false}
      completeness={{ complete: false, missing: [] } as unknown as CompletenessResult}
      eventType="idol" showStartTime={null} hardOutTime={null}
      schedule={[]} setlist={[]} micMap={micMap} members={members} songs={[]} lineup={[]}
    />
  );
}

describe("Summary 'Lineup & Mics' and the show's own Mic Map", () => {
  it("prints the show's mic, not the member's standing one", () => {
    mount([mic("a1", 5, "Aya", 1)]);
    expect(screen.queryByText(/1 · Aya/)).toBeNull();
    expect(screen.getByText("5 · Aya")).toBeTruthy();
  });

  it("with no per-event rows, still prints the standing mic numbers", () => {
    mount([]);
    expect(screen.getByText(/1 · Aya/)).toBeTruthy();
  });

  it("a shared mic lists its holders in rotation order", () => {
    mount([mic("a2", 2, "Mei", 2), mic("a1", 2, "Aya", 1)], [aya, member("m2", "Mei", 2, 2)]);
    expect(screen.getByText("2 · Aya, Mei")).toBeTruthy();
  });
});

describe("the Summary and the Excel agree", () => {
  it("showMicRows is micBaseRows' per-event rows", () => {
    const map = [mic("x3", 3, "Guest", 1), mic("x1", 1, "Mei", 2), mic("x2", 1, "Aya", 1), mic("x4", 4, "", 1)];
    expect(showMicRows(map).map((r) => [r.num, r.holders])).toEqual(micBaseRows(map, []));
  });
});
