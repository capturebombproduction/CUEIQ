// สมุดซ้อม, Black Stage (spec §G.6): attendance is member chips — the member's
// colour as a ring, a check when they are here, pressed state for a screen
// reader — and nothing in the journal leads with an emoji. A log whose category
// this build does not know reads as a note instead of taking the tab down.
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { Member, PracticeLog } from "@/lib/types";

const h = vi.hoisted(() => ({ logs: [] as unknown[], attendance: [] as unknown[] }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const data =
        table === "practice_logs" ? h.logs : table === "practice_attendance" ? h.attendance : [];
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve({ data, error: null }).then(ok, fail);
      return b;
    },
  }),
}));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PracticeJournal } from "./practice-journal";

const EMOJI = /\p{Extended_Pictographic}|✓/u;

const member = (id: string, nickname: string, color: string | null): Member =>
  ({ id, tenant_id: "t1", group_id: "g1", name: nickname, nickname, mic_number: null, color, sort_order: 0 }) as Member;
const log = (id: string, extra: Partial<PracticeLog>): PracticeLog =>
  ({
    id,
    tenant_id: "t1",
    group_id: "g1",
    event_id: "e1",
    log_date: "2026-09-30",
    author_id: "u1",
    visibility: "shared",
    category: "note",
    body: `body-${id}`,
    target_member_id: null,
    done: false,
    created_at: "2026-09-30T10:00:00Z",
    updated_at: "2026-09-30T10:00:00Z",
    ...extra,
  }) as PracticeLog;

const mount = (members: Member[]) =>
  render(
    <ConfirmProvider>
      <PracticeJournal
        eventId="e1"
        groupId="g1"
        tenantId="t1"
        members={members}
        canManage
        currentUserId="u1"
        refreshSignal={0}
      />
    </ConfirmProvider>
  );

describe("PracticeJournal — Black Stage", () => {
  it("attendance is member chips: colour ring, a check when here, pressed state — no ✓ text", async () => {
    h.logs = [];
    h.attendance = [{ id: "a1", member_id: "m1", present: true, event_id: "e1", log_date: "2026-09-30" }];
    mount([member("m1", "มายด์", "#e11d48"), member("m2", "ข้าวหอม", null)]);
    const here = await screen.findByRole("button", { name: "มายด์" });
    const away = screen.getByRole("button", { name: "ข้าวหอม" });
    expect(here.getAttribute("aria-pressed")).toBe("true");
    expect(away.getAttribute("aria-pressed")).toBe("false");
    expect(here.querySelector("svg.lucide-check")).toBeTruthy();
    expect(away.querySelector("svg.lucide-check")).toBeNull();
    // the member's own colour, as a ring
    expect((here.querySelector("[style]") as HTMLElement).style.boxShadow).toMatch(/#e11d48|225, 29, 72/);
    expect(here.textContent).not.toMatch(EMOJI);
  });

  it("the carried-over homework is headed by an icon and a word, never 📌", async () => {
    h.attendance = [];
    h.logs = [log("hw", { category: "homework", done: false, body: "ฝึก Verse 2" })];
    mount([]);
    const box = await screen.findByRole("region", { name: "Homework" });
    expect(within(box).getByRole("heading", { name: /การบ้านค้าง/ })).toBeTruthy();
    expect(box.textContent).not.toMatch(EMOJI);
  });

  it("a log in a category this build does not know reads as a note", async () => {
    h.attendance = [];
    h.logs = [log("x", { category: "rehearsal-plan" as never, body: "body-unknown" })];
    mount([]);
    expect(await screen.findByText("body-unknown")).toBeTruthy();
  });

  // CQ-62: no autoprefixer in this build, so a Tailwind `[scrollbar-width:none]` left
  // Safari before 18.2 drawing a scrollbar under the category chips. `.no-scrollbar`
  // (app/globals.css) carries both engines' rules — and `[scrollbar-width:none]` STAYS
  // beside it, because the .exe does not import globals.css (it shares only theme.css +
  // stage.css), so there the Tailwind class is the only thing hiding the bar.
  // jsdom has no layout — a class pin.
  it("the category chip row hides its scrollbar through .no-scrollbar (and keeps the .exe's own rule)", async () => {
    h.attendance = [];
    h.logs = [];
    mount([]);
    const row = await screen.findByRole("group", { name: "ประเภทบันทึก" });
    const c = (row.getAttribute("class") ?? "").split(/\s+/);
    expect(c).toContain("no-scrollbar");
    expect(c).toContain("[scrollbar-width:none]");
    expect(c).toContain("overflow-x-auto");
  });
});
