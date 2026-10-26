// 2026-10-27 hunt (events): get_shared_event(p_token uuid) - a token that is
// not a uuid (a link pasted with a trailing ")" or ".", cut short in a chat) makes
// PostgREST answer 400 / 22P02 "invalid input syntax for type uuid". Since c4388cf the
// page treats EVERY rpc error as a transient outage: "โหลดไม่สำเร็จ — ลองใหม่อีกครั้ง /
// ไม่ต้องขอลิงก์ใหม่" + a reload link that can never work. Before, it said the link is
// not valid - which is the truth for this one.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as unknown },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: async () => h.result }),
}));

import SharePage from "@/app/share/[token]/page";

describe("share page · a token that is not a uuid", () => {
  it("says the link is not valid, not 'try again, no need for a new link'", async () => {
    const TOKEN = "0b2c4f0e-1111-4111-8111-111111111111)";
    h.result = {
      data: null,
      error: {
        message: `invalid input syntax for type uuid: "${TOKEN}"`,
        code: "22P02",
      },
    };
    render(await SharePage({ params: Promise.resolve({ token: TOKEN }) }));
    expect(screen.queryByText(/ไม่ต้องขอลิงก์ใหม่/)).toBeNull();
    expect(screen.getByText(/ลิงก์ไม่ถูกต้อง/)).toBeTruthy();
  });
});
