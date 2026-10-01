import { act, render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it } from "vitest";
import { Toaster, TOAST_OFFSET } from "./sonner";

afterEach(() => {
  act(() => void toast.dismiss());
});

async function showSuccess() {
  act(() => void toast.success("บันทึกแล้ว", { description: "เซ็ตลิสต์ · 16 รายการ" }));
  return waitFor(() => {
    const li = document.querySelector<HTMLElement>("[data-sonner-toast]");
    if (!li) throw new Error("no toast yet");
    return li;
  });
}

describe("Toaster", () => {
  // app/layout.tsx and desktop main.tsx still pass `richColors`; rich colours paint
  // the whole card a theme-blind pastel, which is what the status rail replaces.
  it("never renders rich colours, whatever the caller passes", async () => {
    render(<Toaster richColors />);
    const li = await showSuccess();
    expect(li.getAttribute("data-rich-colors")).toBe("false");
  });

  it("marks a success with the rail + tinted icon recipe, on the popover slab", async () => {
    render(<Toaster />);
    const li = await showSuccess();
    expect(li.getAttribute("data-type")).toBe("success");
    expect(li.className).toContain("[--toast-rail:4px]");
    expect(li.className).toContain("[--toast-rail-c:var(--success)]");
    expect(li.className).toContain("group-[.toaster]:bg-popover");
  });

  it("sits under the sticky header at the top centre — on phones too", async () => {
    render(<Toaster />);
    await showSuccess();
    const ol = document.querySelector<HTMLElement>("[data-sonner-toaster]")!;
    expect(ol.getAttribute("data-y-position")).toBe("top");
    expect(ol.getAttribute("data-x-position")).toBe("center");
    expect(ol.style.getPropertyValue("--offset-top")).toBe(TOAST_OFFSET);
    // sonner reads a separate offset at <= 600 px; the default 16 px lands on the header
    expect(ol.style.getPropertyValue("--mobile-offset-top")).toBe(TOAST_OFFSET);
  });
});
