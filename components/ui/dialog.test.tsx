import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Button } from "./button";
import { ConfirmProvider, useConfirm, type ConfirmOptions } from "./confirm-dialog";

const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);

function Sheet({ title = "Edit mics" }: { title?: string }) {
  return (
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>รายละเอียด</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary">ยกเลิก</Button>
          <Button>บันทึก</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("is a bottom sheet below sm and a centred panel from sm, scrolling inside a capped height", () => {
    render(<Sheet />);
    const c = classes(screen.getByRole("dialog"));
    expect(c).toEqual(expect.arrayContaining(["bottom-0", "inset-x-0", "rounded-t-[12px]", "data-[state=open]:animate-sheet-in"]));
    expect(c).toEqual(expect.arrayContaining(["sm:top-[50%]", "sm:left-[50%]", "sm:translate-y-[-50%]"]));
    // Load-bearing: a fixed panel taller than the viewport cannot be scrolled to.
    expect(c).toEqual(expect.arrayContaining(["max-h-[85vh]", "sm:max-h-[85vh]", "overflow-y-auto"]));
  });

  it("clears the home indicator: bottom padding includes the safe area", () => {
    render(<Sheet />);
    expect(classes(screen.getByRole("dialog")).some((k) => k.includes("safe-area-inset-bottom"))).toBe(true);
  });

  it("shows a decorative grabber on the sheet only", () => {
    render(<Sheet />);
    const grabber = screen.getByRole("dialog").querySelector("[data-sheet-grabber]");
    expect(grabber).not.toBeNull();
    expect(grabber!.getAttribute("aria-hidden")).toBe("true");
    expect(classes(grabber)).toContain("sm:hidden");
  });

  // Glass is for the two sticky bars only; a blur under a sheet repaints the screen.
  it("dims behind with a flat scrim — no backdrop blur", () => {
    render(<Sheet />);
    const overlay = document.querySelector("[data-state=open].fixed.inset-0") as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(overlay.className).not.toMatch(/backdrop-blur/);
  });

  it("the close button is a 44 px target that still says Close", () => {
    render(<Sheet />);
    const close = screen.getByRole("button", { name: "Close" });
    expect(classes(close)).toEqual(expect.arrayContaining(["h-11", "w-11"]));
  });

  it("an English title is the display H2; a Thai one stays upright Kanit", () => {
    const { unmount } = render(<Sheet title="Delete event?" />);
    expect(classes(screen.getByRole("heading", { name: "Delete event?" }))).toContain("h2");
    unmount();
    render(<Sheet title="ลบเพลงนี้?" />);
    const thai = classes(screen.getByRole("heading", { name: "ลบเพลงนี้?" }));
    expect(thai).not.toContain("h2");
    expect(thai).toContain("font-semibold");
  });

  it("puts two footer buttons side by side on a phone, thumb-sized", () => {
    render(<Sheet />);
    const footer = screen.getByRole("button", { name: "บันทึก" }).parentElement!;
    expect(classes(footer)).toEqual(expect.arrayContaining(["grid", "grid-cols-2", "[&>button]:h-[50px]", "sm:flex"]));
  });
});

// ── ConfirmDialog ───────────────────────────────────────────────────────────────
let ask: (o: ConfirmOptions) => Promise<boolean>;
function Grab() {
  ask = useConfirm();
  return null;
}
function open(o: ConfirmOptions) {
  render(
    <ConfirmProvider>
      <Grab />
    </ConfirmProvider>
  );
  let result: Promise<boolean>;
  act(() => {
    result = ask(o);
  });
  return () => result;
}

describe("ConfirmDialog", () => {
  it("a delete shows the red trash tile and a solid destructive action with a trash icon", () => {
    open({ title: "Delete event?", description: "กู้คืนไม่ได้", confirmText: "ลบงาน" });
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("[data-confirm-tile]")).not.toBeNull();
    const action = screen.getByRole("button", { name: "ลบงาน" });
    expect(classes(action)).toContain("bg-destructive");
    expect(action.querySelector("svg")).not.toBeNull();
    // An English destructive title is set larger (30 px).
    expect(classes(screen.getByRole("heading", { name: "Delete event?" }))).toContain("text-[30px]");
    // Cancel is the neutral secondary, on the left.
    const cancel = screen.getByRole("button", { name: "ยกเลิก" });
    expect(classes(cancel)).toContain("bg-muted");
    expect(cancel.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a non-destructive confirm has no trash tile and a primary action", () => {
    open({ title: "ส่งให้อนุมัติ?", confirmText: "ส่ง", destructive: false });
    expect(screen.getByRole("dialog").querySelector("[data-confirm-tile]")).toBeNull();
    const action = screen.getByRole("button", { name: "ส่ง" });
    expect(classes(action)).toContain("bg-primary");
    expect(action.querySelector("svg")).toBeNull();
  });

  it("type-to-confirm: a 16 px, 48 px field that nothing rewrites, gating the action exactly as before", async () => {
    const result = open({ title: "Delete band?", requireTyped: "Seishin Kakumei" });
    const field = screen.getByPlaceholderText("Seishin Kakumei") as HTMLInputElement;
    expect(classes(field)).toEqual(expect.arrayContaining(["h-12", "text-base", "sm:text-base"]));
    expect(field.getAttribute("autocapitalize")).toBe("none");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("spellcheck")).toBe("false");
    const action = screen.getByRole("button", { name: "ลบ" });
    expect((action as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "seishin kakumei" } });
    expect((action as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: " Seishin Kakumei " } });
    expect((action as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(action);
    await expect(result()).resolves.toBe(true);
  });
});
