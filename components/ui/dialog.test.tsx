import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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

  it("its one column cannot grow past the panel, so a long unbreakable line never scrolls it sideways", () => {
    // the implicit `auto` track let a grid child's min-width:auto size the column to a
    // 100-character file name: 832 px of content in a 512 px panel (Add Song, 2026-10-03)
    render(<Sheet />);
    expect(classes(screen.getByRole("dialog"))).toContain("grid-cols-[minmax(0,1fr)]");
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

// ── where focus goes when it closes ─────────────────────────────────────────────
// Radix gives focus back to its Trigger and nothing else. A dialog opened from state
// has no Trigger, so Esc dropped keyboard focus on <body> — the next Tab started from
// the top of the page. (jsdom: a click does not focus, so each test focuses the
// opener first, as a keyboard user's Enter on it would have.)
function FromState({
  onCloseAutoFocus,
  typed,
  removeOpenerOnOpen,
}: {
  onCloseAutoFocus?: (e: Event) => void;
  typed?: boolean;
  removeOpenerOnOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {!(removeOpenerOnOpen && open) && (
        <button type="button" onClick={() => setOpen(true)}>
          เปิด
        </button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
          <DialogTitle>Edit mics</DialogTitle>
          <DialogDescription>รายละเอียด</DialogDescription>
          {/* autoFocus moves focus at commit, before Radix looks at what had it */}
          {typed && <input aria-label="พิมพ์" autoFocus />}
        </DialogContent>
      </Dialog>
    </>
  );
}

const pressEscape = () =>
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });

describe("Dialog — focus after it closes", () => {
  it("a dialog opened from state hands focus back to the button that opened it", async () => {
    render(<FromState />);
    const opener = screen.getByRole("button", { name: "เปิด" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(document.activeElement).not.toBe(opener);
    pressEscape();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("…also when a field inside took focus on open (the type-to-confirm input)", async () => {
    render(<FromState typed />);
    const opener = screen.getByRole("button", { name: "เปิด" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText("พิมพ์"));
    pressEscape();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("a caller that takes focus itself (preventDefault) is left alone", async () => {
    render(<FromState onCloseAutoFocus={(e) => e.preventDefault()} />);
    const opener = screen.getByRole("button", { name: "เปิด" });
    opener.focus();
    fireEvent.click(opener);
    pressEscape();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(document.activeElement).not.toBe(opener);
  });

  it("an opener that is gone by the time it closes is skipped, not an error", async () => {
    render(<FromState removeOpenerOnOpen />);
    const opener = screen.getByRole("button", { name: "เปิด" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.queryByRole("button", { name: "เปิด" })).toBeNull();
    pressEscape();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(document.activeElement).toBe(document.body);
  });

  it("each open remembers its OWN opener", async () => {
    render(
      <>
        <FromState />
      </>
    );
    const opener = screen.getByRole("button", { name: "เปิด" });
    for (let i = 0; i < 2; i++) {
      opener.focus();
      fireEvent.click(opener);
      pressEscape();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(opener));
      (document.activeElement as HTMLElement).blur();
    }
  });

  it("a dialog with a Trigger still returns to it", async () => {
    render(
      <Dialog>
        <DialogTrigger>แก้ไข</DialogTrigger>
        <DialogContent>
          <DialogTitle>Edit mics</DialogTitle>
          <DialogDescription>รายละเอียด</DialogDescription>
        </DialogContent>
      </Dialog>
    );
    const trigger = screen.getByRole("button", { name: "แก้ไข" });
    trigger.focus();
    fireEvent.click(trigger);
    pressEscape();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
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

  // The confirm path every delete goes through; requireTyped puts an autoFocus field in it.
  it("a type-to-confirm delete gives focus back to the button that asked", async () => {
    function Asker() {
      const confirm = useConfirm();
      return (
        <button type="button" onClick={() => void confirm({ title: "Delete band?", requireTyped: "Seishin Kakumei" })}>
          ลบวง
        </button>
      );
    }
    render(
      <ConfirmProvider>
        <Asker />
      </ConfirmProvider>
    );
    const asker = screen.getByRole("button", { name: "ลบวง" });
    asker.focus();
    fireEvent.click(asker);
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Seishin Kakumei"));
    pressEscape();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(asker));
  });
});
