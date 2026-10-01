// สมุดซ้อม categories: the composer's category chips and each history entry used to
// lead with the map's emoji (📝 ⚠️ ✅ 📌). They are a lucide icon + the Thai word now.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { PRACTICE_CATEGORY_META, type PracticeCategory, type PracticeLog } from "@/lib/types";

const h = vi.hoisted(() => ({ logs: [] as unknown[] }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const result = { data: table === "practice_logs" ? h.logs : [], error: null };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(ok, fail);
      return b;
    },
  }),
}));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PracticeJournal } from "./practice-journal";

const EMOJI = /\p{Extended_Pictographic}|️/u;
const CATEGORIES: PracticeCategory[] = ["note", "problem", "summary", "homework"];

const log = (category: PracticeCategory, body: string): PracticeLog => ({
  id: `l-${category}`,
  tenant_id: "t1",
  group_id: "g1",
  event_id: "e1",
  log_date: "2026-09-30",
  author_id: "u1",
  visibility: "shared",
  category,
  body,
  target_member_id: null,
  // done, so the carry-over box (its own heading, another slice's) stays out of this
  done: true,
  created_at: "2026-09-30T10:00:00Z",
  updated_at: "2026-09-30T10:00:00Z",
});

describe("PracticeJournal categories", () => {
  it("are icon + word in the composer and in the history, never an emoji", async () => {
    h.logs = CATEGORIES.map((c) => log(c, `body-${c}`));
    const { container } = render(
      <ConfirmProvider>
        <PracticeJournal
          eventId="e1"
          groupId="g1"
          tenantId="t1"
          members={[]}
          canManage
          currentUserId="u1"
          refreshSignal={0}
        />
      </ConfirmProvider>
    );
    await screen.findByText("body-homework");

    expect(container.textContent).not.toMatch(EMOJI);
    for (const c of CATEGORIES) {
      const { label, icon } = PRACTICE_CATEGORY_META[c];
      const glyphs = [...container.querySelectorAll(`svg.lucide-${icon}`)];
      // one on the composer's category chip, one on this category's history entry
      expect(glyphs.length, c).toBe(2);
      for (const g of glyphs) {
        expect(g.getAttribute("aria-hidden"), c).toBe("true");
        expect(g.parentElement!.textContent, c).toBe(label);
      }
    }
  });
});
