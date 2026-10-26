// 2026-10-27 hunt 3 (admin): 17b15ef puts a server crash's digest at the END of the
// client_errors message ("Minified React error #441; visit https://react.dev/errors/441 …
// [digest N]"). The Dev Inbox grouped errors on the first 80 characters, which for #441 is
// the same boilerplate every time - so two different server crashes became ONE "×2" card
// showing only the newest digest and URL, and "ลบกลุ่มนี้" deleted the other unread.
// The same crash seen twice (same digest) is still one card.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { makeSupabaseFake, ok } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { DevInbox } from "@/components/admin/dev-inbox";

afterEach(() => cleanup());

const M441 =
  "Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
const row = (id: string, digest: string, path: string, at: string) => ({
  id, kind: "react", message: `${M441} [digest ${digest}]`, stack: `Error: ${M441}`,
  url: `https://cueiq-mu.vercel.app${path}`, app_version: "17b15ef", created_at: at,
});

async function openErrors(rows: unknown[]) {
  h.supa = makeSupabaseFake({ script: { feedback: ok([]), client_errors: ok(rows) } });
  render(<ConfirmProvider><DevInbox /></ConfirmProvider>);
  fireEvent.mouseDown(await screen.findByRole("tab", { name: /ปัญหา/ }));
  fireEvent.click(await screen.findByRole("tab", { name: /ปัญหา/ }));
}

describe("Dev Inbox: server crashes with the same minified message", () => {
  it("two different digests are two cards, each with its own digest and page", async () => {
    await openErrors([
      row("e2", "2222222222", "/events/b/live", "2026-10-27T11:00:00Z"),
      row("e1", "1111111111", "/overview", "2026-10-27T10:00:00Z"),
    ]);
    await screen.findByText(/digest 2222222222/);
    expect(screen.getByText(/digest 1111111111/)).toBeTruthy();
    expect(screen.getByText("/overview")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "ลบกลุ่มนี้" })).toHaveLength(2);
    expect(screen.queryByText("×2")).toBeNull();
  });

  it("the same digest seen twice is still one card ×2", async () => {
    await openErrors([
      row("e2", "3333333333", "/overview", "2026-10-27T11:00:00Z"),
      row("e1", "3333333333", "/overview", "2026-10-27T10:00:00Z"),
    ]);
    await screen.findByText(/digest 3333333333/);
    expect(screen.getAllByRole("button", { name: "ลบกลุ่มนี้" })).toHaveLength(1);
    expect(screen.getByText("×2")).toBeTruthy();
  });
});
