// Round 15, final verification. The Mics tab's standing-mic tiles and the first
// เพิ่มไมค์'s seed rows were worked out from the `lineup` prop — the list the PAGE
// loaded with. The Lineup tab saves through its own state and never told the page, so
// after an Ar took a sick member off the lineup and opened Mics, the tiles still showed
// that member, and the first เพิ่มไมค์ wrote a per-event row putting them on a mic —
// and per-event rows win on the Summary, the readiness gate, the Excel sheet and the
// JPG. The workspace now keeps ONE live lineup: the Lineup editor reports every move of
// its list (onChange) and the Mics tab and the Summary read that.
//
// These mount the real workspace with the real Lineup and Mics editors (nothing about
// the tabs is mocked; only the network, as a recorded fake) and walk the same path the
// Ar did: Lineup, tap a member, Mics.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeSession, makeSupabaseFake, ok, fail } from "@/test/fakes/supabase";
import type { SupabaseFake } from "@/test/fakes/supabase";
import type { CompletenessResult } from "@/lib/completeness";
import type { EventRow, Group, Member } from "@/lib/types";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/events/e1",
  useSearchParams: () => new URLSearchParams(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { EventWorkspace } from "./event-workspace";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { registerMgmtQueueSink } from "@/lib/mgmt-write";

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
const three = () => [1, 2, 3].map(member);
const ALL = ["m1", "m2", "m3"];

// An insert answers with the rows it was given, each with an id (PostgREST's
// `.insert(rows).select("*")`).
const echo = (call: { values: unknown; terminal: string | null }) => {
  const rows = (Array.isArray(call.values) ? call.values : [call.values]) as Record<string, unknown>[];
  const out = rows.map((r, i) => ({ id: `new-${i}`, created_at: "2026-10-02T00:00:00.000Z", ...r }));
  return ok(call.terminal === "single" ? out[0] : out);
};

let supa: SupabaseFake;

const tree = (lineup: string[]) => (
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
      schedule={[]}
      setlist={[]}
      micMap={[]}
      members={three()}
      songs={[]}
      lineup={lineup}
    />
  </ConfirmProvider>
);
const mount = (lineup: string[] = ALL) => render(tree(lineup));

const tab = (name: string) => screen.getByRole("tab", { name });
/** The mic numbers the Mics tab's standing tiles show, left to right. */
const tiles = (c: HTMLElement) =>
  Array.from(c.querySelectorAll(".mic .num")).map((el) => el.textContent);
const memberButton = (n: number) => screen.findByRole("button", { name: new RegExp(`นิค${n}`) });

async function openMics(user: ReturnType<typeof userEvent.setup>) {
  await user.click(tab("Mics"));
  await screen.findByText("Mic Map");
}

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession(), script: { mic_assignments: echo } });
  h.supa = supa;
  toast.success.mockClear();
  toast.error.mockClear();
  router.refresh.mockClear();
  window.location.hash = "";
});
afterEach(() => {
  registerMgmtQueueSink(null);
  window.location.hash = "";
  document.body.innerHTML = "";
});

describe("EventWorkspace · one live lineup for the Lineup, Mics and Summary tabs", () => {
  it("a member taken off the Lineup tab is not on a mic tile on the Mics tab", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    await user.click(tab("Lineup"));
    await user.click(await memberButton(2));
    await waitFor(() => expect(supa.callsTo("event_members", "delete")).toHaveLength(1));

    await openMics(user);
    expect(tiles(container)).toEqual(["1", "3"]);
  });

  it("…and the first เพิ่มไมค์ seeds the show's map from the people still in the lineup", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    await user.click(tab("Lineup"));
    await user.click(await memberButton(2));
    await waitFor(() => expect(supa.callsTo("event_members", "delete")).toHaveLength(1));

    await openMics(user);
    await user.click(screen.getByRole("button", { name: /เพิ่มไมค์/ }));
    await waitFor(() => expect(supa.callsTo("mic_assignments", "insert")).toHaveLength(1));

    const rows = supa.callsTo("mic_assignments", "insert")[0].values as {
      mic_number: number;
      holder_name: string;
    }[];
    // the tiles that were on screen, then the new mic — the absent member is on none
    expect(rows.map((r) => [r.mic_number, r.holder_name])).toEqual([
      [1, "นิค1"],
      [3, "นิค3"],
      [4, ""],
    ]);
    expect(rows.some((r) => r.holder_name === "นิค2")).toBe(false);
    expect(tiles(container)).toEqual([]); // the show's own map has taken over
  });

  it("a member put back on the Lineup tab is back on a tile", async () => {
    const user = userEvent.setup();
    const { container } = mount(["m1", "m3"]);
    await openMics(user);
    expect(tiles(container)).toEqual(["1", "3"]);

    await user.click(tab("Lineup"));
    await user.click(await memberButton(2));
    await waitFor(() => expect(supa.callsTo("event_members", "insert")).toHaveLength(1));

    await user.click(tab("Mics"));
    expect(tiles(container)).toEqual(["1", "2", "3"]);
  });

  it("a removal the database refuses is rolled back on the Mics tab as well", async () => {
    supa = makeSupabaseFake({
      session: makeSession(),
      script: { mic_assignments: echo, event_members: fail("permission denied") },
    });
    h.supa = supa;
    const user = userEvent.setup();
    const { container } = mount();
    await user.click(tab("Lineup"));
    await user.click(await memberButton(2));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    await openMics(user);
    expect(tiles(container)).toEqual(["1", "2", "3"]);
  });

  it("the Summary shows the live lineup too, before a refresh has brought the saved one", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(tab("Lineup"));
    await user.click(await memberButton(2));
    await waitFor(() => expect(supa.callsTo("event_members", "delete")).toHaveLength(1));

    await user.click(tab("Summary")); // router.refresh is a mock here: the page props never move
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/ขาด: นิค2/)).toBeInTheDocument();
  });
});

// The page's own list still counts: when the SERVER's lineup changes (someone else's
// edit, or this one coming back through router.refresh) the live list follows it — on
// the same terms the Lineup panel is re-seeded on — and an unchanged one never
// overwrites what was just edited.
describe("EventWorkspace · the live lineup and the page's own list", () => {
  it("follows the server's lineup when it changes while the Lineup tab is not the active one", async () => {
    const user = userEvent.setup();
    const { container, rerender } = mount();
    await openMics(user);
    expect(tiles(container)).toEqual(["1", "2", "3"]);

    rerender(tree(["m1", "m3"])); // someone else took m2 off
    await waitFor(() => expect(tiles(container)).toEqual(["1", "3"]));
  });

  it("does not take the server's list back when it has not changed", async () => {
    const user = userEvent.setup();
    const { container, rerender } = mount();
    await user.click(tab("Lineup"));
    await user.click(await memberButton(2));
    await waitFor(() => expect(supa.callsTo("event_members", "delete")).toHaveLength(1));
    await openMics(user);
    expect(tiles(container)).toEqual(["1", "3"]);

    // a refresh that raced the write: the same ids as at load, in a new array
    rerender(tree([...ALL]));
    expect(tiles(container)).toEqual(["1", "3"]);
  });

  // The page re-seeds a HIDDEN Lineup panel when the server's list changes. A write
  // from the panel it replaced can still be in flight; if that one is then refused,
  // its rollback is the old panel's list, which the new panel was never given — it
  // must not put the page back on it.
  it("a refused write from a Lineup panel that has since been replaced does not roll the page back", async () => {
    const held = supa.defer("event_members");
    const user = userEvent.setup();
    const { container, rerender } = mount();
    await user.click(tab("Lineup"));
    await user.click(await memberButton(2)); // the delete is now held open
    await waitFor(() => expect(held.taken).toBe(true));
    await openMics(user);
    expect(tiles(container)).toEqual(["1", "3"]);

    rerender(tree(["m1"])); // the server's list moved: the hidden panel is replaced
    await waitFor(() => expect(tiles(container)).toEqual(["1"]));

    held.resolve(fail("permission denied")); // the OLD panel's write is refused
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(tiles(container)).toEqual(["1"]);
  });

  it("takes the saved list back once the refresh brings it — the other person's changes included", async () => {
    const user = userEvent.setup();
    const { container, rerender } = mount();
    await user.click(tab("Lineup"));
    await user.click(await memberButton(2));
    await waitFor(() => expect(supa.callsTo("event_members", "delete")).toHaveLength(1));
    await openMics(user);
    expect(tiles(container)).toEqual(["1", "3"]);

    // what the refresh returns: m2 gone (ours) and m3 gone too (someone else's)
    rerender(tree(["m1"]));
    await waitFor(() => expect(tiles(container)).toEqual(["1"]));
    // and the Lineup panel agrees with the Mics tab
    await user.click(tab("Lineup"));
    expect((await memberButton(3)).getAttribute("aria-pressed")).toBe("false");
    expect((await memberButton(1)).getAttribute("aria-pressed")).toBe("true");
  });
});
