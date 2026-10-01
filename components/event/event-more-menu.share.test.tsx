// The share link lives in the event hero's ⋯ sheet (spec G.3), and the sheet
// UNMOUNTS its contents every time it closes. Before the redesign the share button
// sat on the page for good, so its own state was the truth for as long as the page
// was open. In the sheet, each reopen mounted a fresh button seeded from the
// page-load props — which after "สร้างลิงก์แชร์" still said "no link":
//
//   create T1 → copy it to the venue → close → reopen → "สร้างลิงก์แชร์" again →
//   press it → T2 is written and the venue's T1 stops opening.
//
// And after a revoke the reverse: the dead token came back with a copy button.
// What is pinned here is the sequence a person actually goes through — open, act,
// close BOTH layers, open again — not the mechanism that keeps the state.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

let supa: SupabaseFake;
vi.mock("@/lib/supabase/client", () => ({ createClient: () => supa }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { EventMoreMenu } from "./event-more-menu";
import { ShareButton } from "./share-button";

const menu = (token: string | null, expiresAt: string | null = null) => (
  <EventMoreMenu eventName="RED REVOLUTION">
    <ShareButton eventId="e1" initialToken={token} initialExpiresAt={expiresAt} />
  </EventMoreMenu>
);

/** The ⋯ sheet, then the share dialog on top of it. */
async function openShare() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /แชร์ลิงก์ run sheet/ }));
  });
  const dialogs = screen.getAllByRole("dialog");
  return dialogs[dialogs.length - 1];
}

/** Close whatever is on top — the share dialog first, then the sheet. */
async function closeTop() {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  });
}

const linkField = (dialog: HTMLElement) =>
  within(dialog).queryByDisplayValue(/\/share\//) as HTMLInputElement | null;

describe("EventMoreMenu · the share link survives the sheet closing", () => {
  beforeEach(() => {
    supa = makeSupabaseFake({ script: { events: ok([{ id: "e1" }]) } });
  });

  it("a link created in the sheet is still there on the next open — no second 'สร้างลิงก์แชร์'", async () => {
    render(menu(null));
    let share = await openShare();
    await act(async () => {
      fireEvent.click(within(share).getByRole("button", { name: /สร้างลิงก์แชร์/ }));
    });
    const created = linkField(share)?.value;
    expect(created).toMatch(/\/share\/[0-9a-f-]{36}$/);

    await closeTop();
    await closeTop();
    expect(screen.queryByRole("dialog")).toBeNull();

    share = await openShare();
    expect(linkField(share)?.value).toBe(created);
    expect(within(share).queryByRole("button", { name: /สร้างลิงก์แชร์/ })).toBeNull();
  });

  it("a revoked link does not come back as live on the next open", async () => {
    render(menu("tok-old"));
    let share = await openShare();
    expect(linkField(share)?.value).toMatch(/\/share\/tok-old$/);
    await act(async () => {
      fireEvent.click(within(share).getByRole("button", { name: /ปิดลิงก์/ }));
    });
    expect(linkField(share)).toBeNull();

    await closeTop();
    await closeTop();
    share = await openShare();
    expect(linkField(share)).toBeNull();
    expect(within(share).getByRole("button", { name: /สร้างลิงก์แชร์/ })).toBeInTheDocument();
  });

  it("once the page brings the row back, the row is the truth again", async () => {
    const { rerender } = render(menu(null));
    let share = await openShare();
    await act(async () => {
      fireEvent.click(within(share).getByRole("button", { name: /สร้างลิงก์แชร์/ }));
    });
    await closeTop();
    await closeTop();
    // A refresh: someone else has since revoked it and made their own.
    rerender(menu("tok-theirs"));
    share = await openShare();
    expect(linkField(share)?.value).toMatch(/\/share\/tok-theirs$/);
  });

  it("a write that touched no row is not remembered", async () => {
    supa = makeSupabaseFake({ script: { events: ok([]) } });
    render(menu(null));
    let share = await openShare();
    await act(async () => {
      fireEvent.click(within(share).getByRole("button", { name: /สร้างลิงก์แชร์/ }));
    });
    expect(linkField(share)).toBeNull();
    await closeTop();
    await closeTop();
    share = await openShare();
    expect(linkField(share)).toBeNull();
  });
});
