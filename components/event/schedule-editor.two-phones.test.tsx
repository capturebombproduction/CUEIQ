// 2026-10-30, hunt 12. A call sheet open on two phones: a tap on a field, with no typing, wrote
// this screen's old copy over what the other had saved since, and "+ add" numbered from this
// screen's list, so two phones adding at once gave both new rows the same sort_order.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ScheduleEditor } from "@/components/event/schedule-editor";
import type { ScheduleItem } from "@/lib/types";

const EVENT = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
const ROW = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  tenant_id: "t1",
  event_id: EVENT,
  kind: "other",
  label: "Call",
  location: null,
  start_time: "19:00:00",
  end_time: null,
  notes: null,
  sort_order: 1,
} as unknown as ScheduleItem;

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({
    session: makeSession(),
    script: {
      schedule_items: (c) =>
        c.verb === "update"
          ? ok([{ id: c.eq.id }])
          : c.verb === "insert"
            ? ok({ ...ROW, id: "bbbbbbbb-0000-4000-8000-000000000001", ...(c.values as object) })
            : ok([{ sort_order: 7 }]),
    },
  });
  h.supa = supa;
});
afterEach(cleanup);

const mount = () =>
  render(
    <ConfirmProvider>
      <ScheduleEditor eventId={EVENT} tenantId="t1" eventName="Show" initialItems={[ROW]} editable />
    </ConfirmProvider>
  );
const start = () => document.getElementById(`sc-${ROW.id}-start`) as HTMLInputElement;
const updates = () => supa.callsTo("schedule_items", "update");
const insertedSort = () => (supa.callsTo("schedule_items", "insert")[0].values as { sort_order: number }).sort_order;
const addButton = () => screen.getAllByRole("button").find((b) => /ถึงสถานที่/.test(b.textContent ?? ""))!;

describe("ScheduleEditor with another phone on the same sheet", () => {
  it("a time touched and left writes nothing (the server's 19:00:00 is the box's 19:00)", async () => {
    mount();
    await act(async () => {
      fireEvent.focus(start());
      fireEvent.blur(start());
    });
    expect(updates()).toHaveLength(0);
  });

  it("an empty field touched and left writes nothing", async () => {
    mount();
    const end = document.getElementById(`sc-${ROW.id}-end`) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(end);
      fireEvent.blur(end);
    });
    expect(updates()).toHaveLength(0);
  });

  it("a real edit saves, and one that failed is retried by leaving the field again", async () => {
    supa.setTable("schedule_items", fail("boom"));
    mount();
    await act(async () => {
      fireEvent.change(start(), { target: { value: "20:00" } });
      fireEvent.blur(start());
    });
    expect(updates()).toHaveLength(1);
    await waitFor(() => expect(start().value).toBe("20:00"));
    supa.setTable("schedule_items", ok([{ id: ROW.id }]));
    await act(async () => {
      fireEvent.focus(start());
      fireEvent.blur(start());
    });
    expect(updates()).toHaveLength(2);
  });

  it("a new row is numbered after the SERVER's last, not this screen's", async () => {
    mount();
    fireEvent.click(addButton());
    await waitFor(() => expect(supa.callsTo("schedule_items", "insert")).toHaveLength(1));
    expect(insertedSort()).toBe(8);
  });

  it("the server unreadable: numbered from this screen, as before", async () => {
    supa.setTable("schedule_items", (c) =>
      c.verb === "insert" ? ok({ ...ROW, id: "bbbbbbbb-0000-4000-8000-000000000001" }) : fail("boom")
    );
    mount();
    fireEvent.click(addButton());
    await waitFor(() => expect(supa.callsTo("schedule_items", "insert")).toHaveLength(1));
    expect(insertedSort()).toBe(2);
  });
});
