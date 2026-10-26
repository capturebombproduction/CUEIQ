// The event form is the one event screen that does NOT autosave: nothing is
// written until บันทึก. Moving the show start 17:00 → 17:30 and then tapping
// "‹ EVENTS", the tab bar, "กลับไปหน้างาน", or closing the tab used to leave
// silently with the old time in the database — on show day the call sheet kept
// the old time. ("เวลาที่มีการแก้ไข แล้วจะเปลี่ยนหน้าไปหน้าอื่น อยากให้มีการเตือนว่า
// ยังไม่ได้บันทึก", in-app feedback 2026-08-13.)
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { resetDirtyGuard, unsavedWork, unsavedWorkMessage } from "@/lib/dirty-guard";

const h = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/mgmt-write", () => ({ saveEventWrite: h.save }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { EventForm } from "@/components/event/event-form";

const event = {
  id: "e1", tenant_id: "t1", group_id: "g1", name: "งานทดสอบ", event_date: "2026-12-01",
  venue: "Lot of Live (Bangkok)", event_type: "idol", show_start_time: "17:00:00",
  hard_out_time: "17:20:00", status: "draft", notes: null, map_url: null, costume_theme: null,
  deadline: null, deadline_note: null, updated_at: "2026-10-26T00:00:00Z",
};

function renderForm() {
  return render(
    <ConfirmProvider>
      <EventForm mode="edit" tenantId="t1" userId="u1" groups={[{ id: "g1", name: "Seishin" } as never]} event={event as never} />
    </ConfirmProvider>
  );
}

let confirmSpy: ReturnType<typeof vi.spyOn>;
let link: HTMLAnchorElement;
beforeEach(() => {
  resetDirtyGuard();
  h.save.mockReset();
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
  // The header's "‹ EVENTS" / the tab bar / กลับไปหน้างาน: an ordinary in-app anchor.
  link = document.createElement("a");
  link.href = "/dashboard";
  link.textContent = "EVENTS";
  document.body.appendChild(link);
});
afterEach(() => {
  cleanup();
  link.remove();
  confirmSpy.mockRestore();
  resetDirtyGuard();
});

/** Click the link and report whether the guard held it. A held click is stopped
 *  in the guard's own (document, capture) listener; one let through is cancelled
 *  here at the anchor, so jsdom never attempts a real navigation. */
function clickIsHeld(): boolean {
  const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  let reachedLink = false;
  const stop = (ev: Event) => {
    reachedLink = true;
    ev.preventDefault();
  };
  link.addEventListener("click", stop);
  try {
    link.dispatchEvent(click);
  } finally {
    link.removeEventListener("click", stop);
  }
  return !reachedLink;
}

function closeIsHeld(): boolean {
  const ev = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}

const start = () => screen.getByLabelText("เวลาเริ่มโชว์") as HTMLInputElement;

describe("EventForm · leaving with a change nobody saved", () => {
  it("asks before a link takes the user away, and stays when they say no", () => {
    renderForm();
    fireEvent.change(start(), { target: { value: "17:30" } });
    expect(clickIsHeld()).toBe(true);
    expect(String(confirmSpy.mock.calls[0][0])).toContain("ยังไม่ได้กดบันทึก");
  });

  it("asks before the tab is closed or reloaded", () => {
    renderForm();
    fireEvent.change(start(), { target: { value: "17:30" } });
    expect(closeIsHeld()).toBe(true);
  });

  it("the out-of-tree exits (sign-out, the bell) are asked the same question", () => {
    renderForm();
    fireEvent.change(start(), { target: { value: "17:30" } });
    expect(unsavedWorkMessage("signout")).toContain("ยังไม่ได้กดบันทึก");
  });
});

describe("EventForm · nothing to lose", () => {
  it("says nothing when the form was only opened", () => {
    renderForm();
    expect(clickIsHeld()).toBe(false);
    expect(closeIsHeld()).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("says nothing once the value is typed back to what was saved", () => {
    renderForm();
    fireEvent.change(start(), { target: { value: "17:30" } });
    fireEvent.change(start(), { target: { value: "17:00" } });
    expect(clickIsHeld()).toBe(false);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("says nothing after บันทึก succeeded", async () => {
    h.save.mockResolvedValue({ ok: true, queued: false });
    renderForm();
    fireEvent.change(start(), { target: { value: "17:30" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "บันทึก" }));
    });
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(unsavedWork().drafts).toBeUndefined();
    expect(closeIsHeld()).toBe(false);
  });

  it("still asks when บันทึก failed", async () => {
    h.save.mockResolvedValue({ ok: false, message: "boom" });
    renderForm();
    fireEvent.change(start(), { target: { value: "17:30" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "บันทึก" }));
    });
    expect(closeIsHeld()).toBe(true);
  });

  it("a form that has gone away leaves nothing behind to ask about", () => {
    const { unmount } = renderForm();
    fireEvent.change(start(), { target: { value: "17:30" } });
    unmount();
    expect(unsavedWorkMessage()).toBeNull();
  });
});
