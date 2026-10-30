// 2026-10-30, hunt 12. The running-order builder deleted any row, the act on stage too: the
// caller's board was left with no NOW, offering the first act still waiting, while that act
// stood on stage. The builder only sends, so its own rows know nothing of the board's presses.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { RunOrderBuilder, type RunSequence } from "@/components/event/run-order-builder";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const ROW = {
  id: "r1", tenant_id: "t1", event_name: "Fest", event_date: "2026-08-09", sort_order: 1, title: "Act",
  kind: "band", planned_start: null, planned_end: null, buffer_seconds: 0, linked_event_id: null,
} as RunSequence;

let supa: SupabaseFake;
let status: string;
beforeEach(() => {
  vi.clearAllMocks();
  status = "pending";
  supa = makeSupabaseFake({
    session: makeSession(),
    script: { run_sequence: (c) => (c.verb === "delete" ? ok([{ id: ROW.id }]) : ok([{ ...ROW, status }])) },
  });
  h.supa = supa;
});
afterEach(cleanup);

const mount = () =>
  render(
    <ConfirmProvider>
      <RunOrderBuilder tenantId="t1" eventName="Fest" eventDate="2026-08-09" initial={[ROW]} bandEvents={[]} />
    </ConfirmProvider>
  );
const press = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "ลบ" }));
  });
};
// the row's own ลบ, then the sheet's: the sheet hides what is under it from the role query
const answerYes = async () => {
  const go = await waitFor(() => {
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    const b = dialog && Array.from(dialog.querySelectorAll("button")).find((x) => /ลบ|ยืนยัน/.test(x.textContent ?? ""));
    if (!b) throw new Error("no sheet");
    return b;
  });
  await act(async () => {
    fireEvent.click(go);
  });
};

describe("RunOrderBuilder: deleting a row", () => {
  it("the act on stage is refused, no question asked", async () => {
    status = "live";
    mount();
    await press();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("แถวนี้กำลังขึ้นเวทีอยู่ — ยังลบไม่ได้", expect.anything())
    );
    expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(supa.callsTo("run_sequence", "delete")).toHaveLength(0);
  });

  it("an act that went on stage while the question was open is refused", async () => {
    mount();
    await press();
    await waitFor(() => expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).not.toBeNull());
    status = "live";
    await answerYes();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(supa.callsTo("run_sequence", "delete")).toHaveLength(0);
  });

  it("an act waiting or done is deleted as before", async () => {
    mount();
    await press();
    await answerYes();
    await waitFor(() => expect(supa.callsTo("run_sequence", "delete")).toHaveLength(1));
  });

  it("no answer about its status: the delete is not refused", async () => {
    supa.setTable("run_sequence", (c) => (c.verb === "delete" ? ok([{ id: ROW.id }]) : fail("boom")));
    mount();
    await press();
    await answerYes();
    await waitFor(() => expect(supa.callsTo("run_sequence", "delete")).toHaveLength(1));
  });
});
