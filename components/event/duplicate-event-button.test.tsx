// The duplicate button sits INSIDE a card that is one big <Link>. Its dialog
// renders in a portal, but React bubbles portal events up the component tree —
// so a press anywhere in the dialog would also "click" the card and open the show
// being copied instead of the copy. This pins the stop, plus that the name and
// date typed in the dialog are what the new show is created with.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const calls = vi.hoisted(() => ({ built: [] as Record<string, unknown>[] }));
vi.mock("@/lib/clone-event", () => ({
  cloneEvent: async (_s: unknown, o: { buildEvent: (r: Record<string, unknown>) => Record<string, unknown> }) => {
    calls.built.push(o.buildEvent({ tenant_id: "t1", group_id: "g1", event_type: "idol" }));
    return { newId: "new-1", failed: [], attempted: 4 };
  },
}));

import { DuplicateEventButton } from "./duplicate-event-button";

const cardClick = vi.fn();
const mount = () =>
  render(
    <ConfirmProvider>
      <div onClick={cardClick}>
        <DuplicateEventButton eventId="e1" eventName="Sourgrumy" />
      </div>
    </ConfirmProvider>
  );

beforeEach(() => {
  calls.built = [];
  cardClick.mockClear();
  push.mockClear();
});

describe("DuplicateEventButton", () => {
  it("asks for the new name and date, creates the show with them, and opens it", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /ก๊อปงาน Sourgrumy/ }));
    fireEvent.change(screen.getByLabelText("ชื่องานใหม่"), { target: { value: "Ichiban idol vol25" } });
    fireEvent.change(screen.getByLabelText(/วันที่งาน/), { target: { value: "2026-10-05" } });
    fireEvent.click(screen.getByRole("button", { name: /^ก๊อปงาน$/ }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/events/new-1"));
    expect(calls.built[0]).toMatchObject({ name: "Ichiban idol vol25", event_date: "2026-10-05", status: "draft" });
  });

  it("an untouched name falls back to “(สำเนา)” and an empty date stays empty", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /ก๊อปงาน Sourgrumy/ }));
    fireEvent.click(screen.getByRole("button", { name: /^ก๊อปงาน$/ }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(calls.built[0]).toMatchObject({ name: "Sourgrumy (สำเนา)", event_date: null });
  });

  it("nothing pressed in the dialog reaches the card underneath", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /ก๊อปงาน Sourgrumy/ }));
    fireEvent.click(screen.getByLabelText("ชื่องานใหม่"));
    fireEvent.click(screen.getByRole("button", { name: "ยกเลิก" }));
    fireEvent.click(screen.getByRole("button", { name: /ก๊อปงาน Sourgrumy/ }));
    fireEvent.click(screen.getByRole("button", { name: /^ก๊อปงาน$/ }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(cardClick).not.toHaveBeenCalled();
  });
});
