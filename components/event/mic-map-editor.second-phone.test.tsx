// 2026-10-30, hunt 12. A show with no mics of its own, Mics open on two phones: both show the
// standing mics, and each one's first เพิ่มไมค์ seeded all of them. The second seed landed on top
// of the first, so every mic read "วนไมค์ 2 คน" on the Summary, the sheet and the share page.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, fail, type SupabaseFake, type RecordedCall } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { MicMapEditor } from "@/components/event/mic-map-editor";
import type { Member } from "@/lib/types";

const EVENT = "e1";
const member = (n: number) =>
  ({ id: `m${n}`, group_id: "g1", name: `M${n}`, nickname: `N${n}`, mic_number: n, sort_order: n }) as unknown as Member;
const theirs = (n: number) => ({
  id: `theirs-${n}`, tenant_id: "t1", event_id: EVENT, mic_number: n, holder_name: `N${n}`, order_index: 1,
  created_at: "2026-10-30T00:00:00Z",
});

let supa: SupabaseFake;
const inserted = (c: RecordedCall) => {
  const rows = (Array.isArray(c.values) ? c.values : [c.values]) as Record<string, unknown>[];
  return ok(c.terminal === "single" ? rows[0] : rows);
};
const script = (onServer: unknown[]) => (c: RecordedCall) => (c.verb === "insert" ? inserted(c) : ok(onServer));
const inserts = () => supa.callsTo("mic_assignments", "insert");
const add = () => fireEvent.click(screen.getByRole("button", { name: /เพิ่มไมค์/ }));

beforeEach(() => {
  vi.clearAllMocks();
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
});
afterEach(cleanup);

const mount = () =>
  render(
    <ConfirmProvider>
      <MicMapEditor eventId={EVENT} tenantId="t1" editable initialMics={[]} members={[member(1), member(2)]}
        lineup={[]} setlist={[]} eventName="Show" />
    </ConfirmProvider>
  );

describe("MicMapEditor: the first add when another phone already made the map", () => {
  it("takes the server's map, says so, and adds only the one new mic", async () => {
    supa.setTable("mic_assignments", script([theirs(1), theirs(2)]));
    mount();
    add();
    await waitFor(() => expect(inserts()).toHaveLength(1));
    const v = inserts()[0].values as { mic_number: number };
    expect(Array.isArray(v)).toBe(false);
    expect(v.mic_number).toBe(3);
    expect(toast.info).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getAllByRole("spinbutton").map((e) => Number((e as HTMLInputElement).value))).toEqual([1, 2, 3])
    );
  });

  it("nobody has: it seeds, as before", async () => {
    supa.setTable("mic_assignments", script([]));
    mount();
    add();
    await waitFor(() => expect(inserts()).toHaveLength(1));
    expect((inserts()[0].values as unknown[]).length).toBe(3);
  });

  it("the server unreadable: it seeds, as before", async () => {
    supa.setTable("mic_assignments", (c: RecordedCall) => (c.verb === "insert" ? inserted(c) : fail("boom")));
    mount();
    add();
    await waitFor(() => expect(inserts()).toHaveLength(1));
    expect((inserts()[0].values as unknown[]).length).toBe(3);
  });
});
