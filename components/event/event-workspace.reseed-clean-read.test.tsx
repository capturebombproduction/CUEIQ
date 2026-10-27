// 2026-10-27 (hunt 6): a tab left with server data it missed is re-seeded only from a
// read that holds everything it saved.
//
// ตาที่ 3 made leaving such a tab read again and re-seed it from the next props, whatever
// they held. Two kinds of "next props" are older than the tab's own last edit:
//   • the desktop: a refresh that cannot reach the server is served from the read-cache
//     (desktop/src/data/event-bundle.ts) - the last ONLINE read, as new arrays - so a
//     label saved online as C after that read came back as B;
//   • the web: the leave-tab read waits at most 2.5 s for the saves on the wire, and on
//     venue wifi the last one was still out when it went - its answer said B.
// Either way the panel showed B again, and its next blur wrote B over the server's C.
// What the re-seed is for still works: a read with another device's newer data, sent
// with nothing on the wire while the tab is hidden, re-seeds it.
//
// The real workspace with the real editors; only the network is a recorded fake, and
// router.refresh is a mock - a "refresh" landing is the test re-rendering new props.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeSession, makeSupabaseFake, ok } from "@/test/fakes/supabase";
import type { SupabaseFake, RecordedCall } from "@/test/fakes/supabase";
import type { CompletenessResult } from "@/lib/completeness";
import type { EventRow, Group, ScheduleItem } from "@/lib/types";

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

let supa: SupabaseFake;
/** what the server holds for s1's label */
let serverLabel = "A";
let onLine = true;

const tree = (schedule: ScheduleItem[], cachedCopy = false) => (
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
      members={[]}
      songs={[]}
      lineup={[]}
      cachedCopy={cachedCopy}
    />
  </ConfirmProvider>
);

beforeEach(() => {
  serverLabel = "A";
  onLine = true;
  vi.spyOn(window.navigator, "onLine", "get").mockImplementation(() => onLine);
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
    },
  });
  h.supa = supa;
  router.refresh.mockClear();
  resetDirtyGuard();
  window.location.hash = "";
});
afterEach(() => {
  vi.restoreAllMocks();
  resetDirtyGuard();
  window.location.hash = "";
  document.body.innerHTML = "";
});

const tab = (name: string) => screen.getByRole("tab", { name });
const label = () => document.getElementById("sc-s1-label") as HTMLInputElement;
const location = () => document.getElementById("sc-s1-location") as HTMLInputElement;
/** type into the Schedule row's label and leave the field - its autosave */
async function saveLabel(value: string) {
  fireEvent.change(label(), { target: { value } });
  fireEvent.blur(label());
  await waitFor(() => expect(serverLabel).toBe(value));
}

describe("EventWorkspace · desktop: a refresh served from the read-cache", () => {
  it("does not put a left tab back on the cached value - and no blur writes it over the newer one", async () => {
    const user = userEvent.setup();
    const { rerender } = render(tree([row("A")]));
    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());

    await saveLabel("B");
    rerender(tree([row("B")])); // บันทึก / อัปเดต's online read lands (and is cached: B)
    await saveLabel("C"); // saved online: the server holds C, the cache still B

    onLine = false; // the venue wifi drops
    await user.click(tab("Lineup"));
    // บันทึก / อัปเดต offline: the desktop reload is served from the read-cache
    rerender(tree([row("B")], true));

    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());
    expect(label().value, "the panel keeps the C it saved").toBe("C");
    fireEvent.focus(label());
    fireEvent.blur(label());
    await new Promise((r) => setTimeout(r, 20));
    expect(serverLabel, "no blur writes the cached B over C").toBe("C");
  });

  it("…and the next server read, sent once back online, still re-seeds it with another device's change", async () => {
    const user = userEvent.setup();
    const { rerender } = render(tree([row("A")]));
    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());
    await saveLabel("B");
    rerender(tree([row("B")]));
    await saveLabel("C");

    onLine = false;
    await user.click(tab("Lineup"));
    rerender(tree([row("B")], true)); // the cached copy: nothing re-seeded
    expect(router.refresh).not.toHaveBeenCalled();

    onLine = true;
    // back online, entering Summary reads - with nothing on the wire, the Schedule tab hidden
    await user.click(tab("Summary"));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    rerender(tree([row("C", "ฮอลล์ 2")])); // the server: this device's C + another's location

    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());
    expect(label().value).toBe("C");
    expect(location().value, "the other device's change reached the panel").toBe("ฮอลล์ 2");
  });
});

describe("EventWorkspace · web: the leave-tab read whose wait for the last save ran out", () => {
  it("does not re-seed the tab from that read - and once the save lands, one more read does", async () => {
    const user = userEvent.setup();
    const { rerender } = render(tree([row("A")]));
    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());
    await saveLabel("B");
    rerender(tree([row("B")])); // บันทึก / อัปเดต's read lands while Schedule is active

    const held = supa.defer("schedule_items");
    await user.click(label());
    fireEvent.change(label(), { target: { value: "C" } });
    await user.click(tab("Lineup")); // its blur starts C's save; leaving asks for a read
    await waitFor(() => expect(held.taken).toBe(true));
    router.refresh.mockClear();
    // past the 2.5 s wait the read goes out anyway, C still on the wire
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1), { timeout: 4000 });
    rerender(tree([row("B")])); // so its answer still says B
    await new Promise((r) => setTimeout(r, 20));
    // the hidden panel (kept mounted) was not re-seeded from it
    expect(label().value, "the hidden panel keeps the C it is saving").toBe("C");

    held.resolve(ok([{ id: "s1" }]));
    serverLabel = "C";
    // C landed: the tab still waits, so one more read goes out - nothing on the wire now
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(2), { timeout: 2000 });
    rerender(tree([row("C", "ฮอลล์ 2")]));

    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());
    expect(label().value, "the panel keeps the C it saved").toBe("C");
    expect(location().value, "and gets what the clean read brought").toBe("ฮอลล์ 2");
    fireEvent.focus(label());
    fireEvent.blur(label());
    await new Promise((r) => setTimeout(r, 20));
    expect(serverLabel).toBe("C");
  }, 10000);
});

// Argon on hunt 6: leave the tab (its read goes out, armed), open it again before that
// read lands, save an edit, leave again. The read still out predates the edit, and it
// lands first - it re-seeded the tab with the value from before the edit (asking for
// another read on the second leave would not help: the old answer still lands first).
describe("EventWorkspace · a tab opened again before its read landed", () => {
  it("is not re-seeded by that read - one more read, sent after it landed, re-seeds it", async () => {
    const user = userEvent.setup();
    const { rerender } = render(tree([row("A")]));
    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());
    await saveLabel("B");
    rerender(tree([row("B")])); // a read lands while Schedule is active: it missed it

    router.refresh.mockClear();
    await user.click(tab("Lineup")); // leaving reads again: read #1 goes out, armed
    expect(router.refresh).toHaveBeenCalledTimes(1);
    await user.click(tab("Schedule")); // back before read #1 lands
    await waitFor(() => expect(label()).toBeTruthy());
    await saveLabel("C");
    await user.click(tab("Lineup")); // and off again, still before it lands

    rerender(tree([row("B")])); // read #1 lands - sent before C
    await new Promise((r) => setTimeout(r, 20));
    expect(label().value, "the hidden panel keeps the C it saved").toBe("C");
    // …and one more read goes out for it, now that the old one is in
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(2));
    rerender(tree([row("C", "ฮอลล์ 2")])); // its answer: C + another device's location

    await user.click(tab("Schedule"));
    await waitFor(() => expect(label()).toBeTruthy());
    expect(label().value).toBe("C");
    expect(location().value, "the other device's change reached the panel").toBe("ฮอลล์ 2");
    fireEvent.focus(label());
    fireEvent.blur(label());
    await new Promise((r) => setTimeout(r, 20));
    expect(serverLabel).toBe("C");
  });
});
