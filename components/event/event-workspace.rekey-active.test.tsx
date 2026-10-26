// 2026-10-27 (hunt 3): a refresh that lands while an editor tab is the ACTIVE one.
//
// The workspace re-keys (remounts, re-seeds) a hidden panel when the server data it was
// seeded from changes, and never the active one. But the active tab was skipped BEFORE
// its fingerprint was recorded, so it kept the one from before the refresh - and the
// moment the Ar LEFT the tab, the panel was re-keyed from the props that refresh had
// brought: props older than every edit she made after it. บันทึก / อัปเดต on Schedule
// (row = B), then C saved, then another tab and back: the row showed B again, and the
// next focus + blur on it wrote B over C. The live lineup was taken back from that same
// old list, so a member taken off after the refresh was on a Mics tile again (and in the
// first เพิ่มไมค์'s seed: the round-15 bug).
//
// And its sibling: entering Summary (and บันทึก / อัปเดต) refreshed AT ONCE, while the
// save the click's own blur had just started was still on the wire - a read that won
// that race re-seeded the panel just left without the last edit. Both now refresh once
// the writes on the wire have landed.
//
// The real workspace with the real editors; only the network is a recorded fake, and
// router.refresh is a mock - a "refresh" landing is the test re-rendering new props.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeSession, makeSupabaseFake, ok } from "@/test/fakes/supabase";
import type { SupabaseFake, RecordedCall } from "@/test/fakes/supabase";
import type { CompletenessResult } from "@/lib/completeness";
import type { EventRow, Group, Member, ScheduleItem } from "@/lib/types";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/events/e1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { EventWorkspace } from "./event-workspace";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { resetDirtyGuard } from "@/lib/dirty-guard";

const event = {
  id: "e1",
  tenant_id: "t1",
  group_id: "g1",
  name: "งานทดสอบ",
  event_date: "2026-12-01",
  event_type: "idol",
  status: "in_progress",
  is_template: false,
  group: { id: "g1", tenant_id: "t1", name: "วงทดสอบ" } as Group,
} as unknown as EventRow & { group: Group | null };

const row = (label: string, location: string | null = null): ScheduleItem => ({
  id: "s1",
  tenant_id: "t1",
  event_id: "e1",
  kind: "stage",
  label,
  location,
  start_time: "18:00:00",
  end_time: null,
  notes: null,
  sort_order: 1,
});

const member = (n: number): Member => ({
  id: `m${n}`,
  tenant_id: "t1",
  group_id: "g1",
  name: `สมาชิก ${n}`,
  nickname: `นิค${n}`,
  mic_number: n,
  color: null,
  sort_order: n,
  created_at: "2026-01-01T00:00:00.000Z",
});
const members = [1, 2, 3].map(member);

let supa: SupabaseFake;
/** what the server holds for s1's label */
let serverLabel = "A";
/** who the server has in the lineup */
let serverLineup: string[] = [];

const tree = (schedule: ScheduleItem[], lineup: string[] = []) => (
  <ConfirmProvider>
    <EventWorkspace
      event={event}
      eventId="e1"
      tenantId="t1"
      editable
      completeness={{ complete: false, missing: [] } as unknown as CompletenessResult}
      eventType="idol"
      showStartTime={null}
      hardOutTime={null}
      schedule={schedule}
      setlist={[]}
      micMap={[]}
      members={members}
      songs={[]}
      lineup={lineup}
    />
  </ConfirmProvider>
);

beforeEach(() => {
  serverLabel = "A";
  serverLineup = ["m1", "m2", "m3"];
  supa = makeSupabaseFake({
    session: makeSession(),
    script: {
      schedule_items: (call: RecordedCall) => {
        if (call.verb === "update") {
          const v = call.values as { label?: string };
          if (v.label !== undefined) serverLabel = v.label;
          return ok([{ id: "s1" }]);
        }
        return ok([]);
      },
      event_members: (call: RecordedCall) => {
        if (call.verb === "delete") {
          const id = call.eq.member_id as string;
          serverLineup = serverLineup.filter((x) => x !== id);
          return ok([{ member_id: id }]);
        }
        return ok([]);
      },
    },
  });
  h.supa = supa;
  router.refresh.mockClear();
  resetDirtyGuard();
  window.location.hash = "";
});
afterEach(() => {
  resetDirtyGuard();
  window.location.hash = "";
  document.body.innerHTML = "";
});

const tab = (name: string) => screen.getByRole("tab", { name });
const label = () => document.getElementById("sc-s1-label") as HTMLInputElement;
/** type into the Schedule row's label and leave the field - its autosave */
async function saveLabel(value: string) {
  fireEvent.change(label(), { target: { value } });
  fireEvent.blur(label());
  await waitFor(() => expect(serverLabel).toBe(value));
}
/** the mic numbers on the Mics tab's standing tiles, left to right */
const tiles = (c: HTMLElement) => Array.from(c.querySelectorAll(".mic .num")).map((el) => el.textContent);

describe("EventWorkspace · a refresh that landed while the tab was active", () => {
  it("an edit saved after it survives leaving the tab and coming back - and no blur writes the old value back", async () => {
    const user = userEvent.setup();
    const { rerender } = render(tree([row("A")]));
    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());

    await saveLabel("B");
    rerender(tree([row("B")])); // บันทึก / อัปเดต's refresh lands, Schedule still active
    await saveLabel("C"); // and one more edit after it

    await user.click(tab("Lineup"));
    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());
    expect(label().value, "the panel shows what the server holds").toBe("C");

    fireEvent.focus(label());
    fireEvent.blur(label());
    await new Promise((r) => setTimeout(r, 20));
    expect(serverLabel).toBe("C");
  });

  it("a member taken off after it is not back on a Mics tile", async () => {
    const user = userEvent.setup();
    const { rerender, container } = render(tree([], ["m1", "m2", "m3"]));
    await user.click(tab("Lineup"));
    await user.click(await screen.findByRole("button", { name: /นิค2/ }));
    await waitFor(() => expect(serverLineup).toEqual(["m1", "m3"]));
    rerender(tree([], ["m1", "m3"])); // the refresh, Lineup still active
    await user.click(screen.getByRole("button", { name: /นิค3/ }));
    await waitFor(() => expect(serverLineup).toEqual(["m1"]));

    await user.click(tab("Mics"));
    await screen.findByText("Mic Map");
    expect(tiles(container)).toEqual(["1"]);
    // and the Lineup panel agrees
    await user.click(tab("Lineup"));
    expect((await screen.findByRole("button", { name: /นิค3/ })).getAttribute("aria-pressed")).toBe("false");
  });

  // What the re-key is FOR still works: once the tab is hidden, the next refresh that
  // brings something new (here another device's location, with this one's C) re-seeds it.
  it("the panel is still re-seeded by the next refresh that lands while it is hidden", async () => {
    const user = userEvent.setup();
    const { rerender } = render(tree([row("A")]));
    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());
    await saveLabel("B");
    rerender(tree([row("B")]));
    await saveLabel("C");

    await user.click(tab("Lineup"));
    rerender(tree([row("C", "ฮอลล์ 2")])); // someone else filled the location
    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());
    expect(label().value).toBe("C");
    expect((document.getElementById("sc-s1-location") as HTMLInputElement).value).toBe("ฮอลล์ 2");
  });
});

describe("EventWorkspace · refreshing after the click's own save, not during it", () => {
  it("Summary: with the last edit's save on the wire, the refresh waits for it to land", async () => {
    const user = userEvent.setup();
    render(tree([row("A")]));
    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());

    const held = supa.defer("schedule_items");
    await user.click(label());
    fireEvent.change(label(), { target: { value: "B" } });
    await user.click(tab("Summary")); // the press blurs the field: its save starts
    await waitFor(() => expect(held.taken).toBe(true));
    expect(tab("Summary").getAttribute("data-state")).toBe("active");
    await new Promise((r) => setTimeout(r, 250));
    expect(router.refresh, "no read while the save is on the wire").not.toHaveBeenCalled();

    held.resolve(ok([{ id: "s1" }]));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
  });

  it("Summary with nothing on the wire still refreshes at once", async () => {
    const user = userEvent.setup();
    render(tree([row("A")]));
    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());
    fireEvent.click(tab("Summary"));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("บันทึก / อัปเดต: the refresh waits for the save the press started", async () => {
    const user = userEvent.setup();
    render(tree([row("A")]));
    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());

    const held = supa.defer("schedule_items");
    await user.click(label());
    fireEvent.change(label(), { target: { value: "B" } });
    await user.click(screen.getByRole("button", { name: /บันทึก \/ อัปเดต/ }));
    await waitFor(() => expect(held.taken).toBe(true));
    await new Promise((r) => setTimeout(r, 250));
    expect(router.refresh).not.toHaveBeenCalled();

    held.resolve(ok([{ id: "s1" }]));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
  });
});
