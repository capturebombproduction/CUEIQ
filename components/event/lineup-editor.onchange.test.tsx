// Round 15, final verification. The Lineup editor saves through its own state, and
// nothing else on the page knew: the Mics tab kept reading the lineup the page had
// LOADED with. `onChange` is how the page learns the list as it is now — every move of
// the editor's own list, the optimistic edit and a rollback alike — so what the Mics tab
// and the Summary read can never be older than what the Lineup tab shows.
// (The tabs agreeing end to end is event-workspace.lineup-live.test.tsx.)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeSession, makeSupabaseFake, fail, offline } from "@/test/fakes/supabase";
import type { SupabaseFake } from "@/test/fakes/supabase";
import type { Member } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { LineupEditor } from "@/components/event/lineup-editor";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { registerMgmtQueueSink } from "@/lib/mgmt-write";

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

let supa: SupabaseFake;
const onChange = vi.fn<(lineup: string[]) => void>();

function mount(over: { initial?: string[]; editable?: boolean } = {}) {
  return render(
    <ConfirmProvider>
      <LineupEditor
        eventId="e1"
        tenantId="t1"
        editable={over.editable ?? true}
        members={[1, 2, 3].map(member)}
        initialLineup={over.initial ?? ["m1", "m2", "m3"]}
        eventName="งานทดสอบ"
        onChange={onChange}
      />
    </ConfirmProvider>
  );
}
const sorted = (ids: string[]) => [...ids].sort();
const lastReported = () => sorted(onChange.mock.calls.at(-1)![0]);

beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  onChange.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  registerMgmtQueueSink(null);
  document.body.innerHTML = "";
});

describe("LineupEditor · tells the page who is performing now", () => {
  it("taking a member off reports the list without them, once", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: /นิค2/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastReported()).toEqual(["m1", "m3"]);
  });

  it("putting a member back reports the list with them", async () => {
    const user = userEvent.setup();
    mount({ initial: ["m1"] });
    await user.click(screen.getByRole("button", { name: /นิค3/ }));
    expect(lastReported()).toEqual(["m1", "m3"]);
  });

  it("เลือกทั้งหมด reports the whole band", async () => {
    const user = userEvent.setup();
    mount({ initial: ["m1"] });
    await user.click(screen.getByRole("button", { name: /เลือกทั้งหมด/ }));
    expect(lastReported()).toEqual(["m1", "m2", "m3"]);
  });

  it("ล้าง reports an empty list — and only once the confirm dialog is answered yes", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: /ล้าง$/ }));
    expect(onChange).not.toHaveBeenCalled(); // the dialog is up; nothing has moved
    await user.click(await screen.findByRole("button", { name: "ล้างทั้งหมด" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(lastReported()).toEqual([]);
  });

  it("a write the database refuses is reported twice: the edit, then the rollback", async () => {
    supa.setTable("event_members", fail("permission denied"));
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: /นิค2/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onChange.mock.calls.map(([ids]) => sorted(ids))).toEqual([
      ["m1", "m3"],
      ["m1", "m2", "m3"],
    ]);
  });

  it("a failed เลือกทั้งหมด is rolled back in what the page was told", async () => {
    supa.setTable("event_members", fail("permission denied"));
    const user = userEvent.setup();
    mount({ initial: ["m1"] });
    await user.click(screen.getByRole("button", { name: /เลือกทั้งหมด/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(lastReported()).toEqual(["m1"]);
  });

  it("offline on the desktop the edit is queued and stays reported (it IS saved, locally)", async () => {
    registerMgmtQueueSink(vi.fn<(op: unknown) => Promise<void>>(async () => {}));
    supa.setTable("event_members", offline());
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: /นิค2/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastReported()).toEqual(["m1", "m3"]);
  });

  it("a read-only viewer's taps change nothing and report nothing", async () => {
    const user = userEvent.setup();
    mount({ editable: false });
    await user.click(screen.getByRole("button", { name: /นิค2/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(supa.callsTo("event_members")).toHaveLength(0);
  });
});
