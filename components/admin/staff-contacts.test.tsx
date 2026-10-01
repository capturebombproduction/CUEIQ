// Crew (spec §G.9): the label's crew directory reads as contact cards you can call
// from — a tap on the phone button dials — and its fields open only when you mean
// to edit. Saving is unchanged (on blur, through the write guard).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { StaffContactsManager, telHref } from "@/components/admin/staff-contacts";
import type { StaffContact } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const T = "33333333-3333-4333-8333-333333333333";
const contact = (over: Partial<StaffContact> & { id: string }): StaffContact => ({
  tenant_id: T,
  name: "",
  role: "",
  phone: "",
  sort_order: 1,
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

function mount(rows: StaffContact[]) {
  return render(
    <ConfirmProvider>
      <StaffContactsManager tenantId={T} initial={rows} />
    </ConfirmProvider>
  );
}

afterEach(() => cleanup());

describe("telHref", () => {
  it("dials the digits of whatever was typed, keeping a leading +", () => {
    expect(telHref("081-234 5678")).toBe("tel:0812345678");
    expect(telHref("+66 81 234 5678")).toBe("tel:+66812345678");
  });
  it("offers no call for a number that is not one", () => {
    expect(telHref("")).toBeNull();
    expect(telHref(null)).toBeNull();
    expect(telHref("—")).toBeNull();
  });
});

describe("crew contact cards", () => {
  it("show name, role and number with a call button, and no fields until edit is asked for", () => {
    mount([contact({ id: "c1", name: "พี่พัชร์", role: "ช่างภาพ", phone: "081-234 5678" })]);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    const call = screen.getByRole("link", { name: /โทรหา พี่พัชร์/ });
    expect(call).toHaveAttribute("href", "tel:0812345678");
    const card = call.closest("li")!;
    expect(card.textContent).toContain("ช่างภาพ");
    expect(card.textContent).toContain("081-234 5678");

    fireEvent.click(within(card).getByRole("button", { name: /แก้ไข/ }));
    expect(screen.getByRole("textbox", { name: "ชื่อ" })).toHaveValue("พี่พัชร์");
    expect(screen.getByRole("textbox", { name: "เบอร์โทร" })).toHaveValue("081-234 5678");

    fireEvent.click(screen.getByRole("button", { name: /เสร็จ/ }));
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("opens a blank row straight into its fields — there is nothing to call yet", () => {
    mount([contact({ id: "c2" })]);
    expect(screen.getByRole("textbox", { name: "ชื่อ" })).toHaveValue("");
    expect(screen.queryByRole("link", { name: /โทรหา/ })).toBeNull();
  });
});
