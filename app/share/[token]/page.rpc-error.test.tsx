// The public run sheet treated a FAILED read as "this link was revoked".
//
// The page kept only `data` from supabase.rpc("get_shared_event") and dropped
// `error`, so a statement timeout / 5xx / PostgREST hiccup at the venue rendered
// "ลิงก์ไม่ถูกต้องหรือถูกปิดการแชร์แล้ว — ลองขอลิงก์ใหม่จากผู้จัดงานอีกครั้ง": the crew was
// told the band withdrew the sheet and to ask for a NEW link — and making a new link
// (ShareButton "ปิดลิงก์" → "สร้างลิงก์แชร์") kills the one already sent everywhere
// else. The rest of the app treats this class as a bug (lib/read-guard.ts).
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as unknown },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: async () => h.result }),
}));

import SharePage from "@/app/share/[token]/page";

const TOKEN = "0b2c4f0e-1111-4111-8111-111111111111";

describe("Share page · the read failed (not revoked, not expired)", () => {
  it("says the load failed and offers the SAME link again", async () => {
    h.result = {
      data: null,
      error: { message: "canceling statement due to statement timeout", code: "57014" },
    };
    render(await SharePage({ params: Promise.resolve({ token: TOKEN }) }));
    expect(screen.queryByText(/ถูกปิดการแชร์แล้ว/)).toBeNull();
    expect(screen.getByText("โหลดไม่สำเร็จ — ลองใหม่อีกครั้ง")).toBeTruthy();
    expect(screen.getByRole("link", { name: "โหลดอีกครั้ง" })).toHaveAttribute("href", `/share/${TOKEN}`);
  });

  it("a token that matches nothing still says the link is not valid", async () => {
    h.result = { data: null, error: null };
    render(await SharePage({ params: Promise.resolve({ token: TOKEN }) }));
    expect(screen.getByText(/ถูกปิดการแชร์แล้ว/)).toBeTruthy();
    expect(screen.queryByText(/โหลดไม่สำเร็จ/)).toBeNull();
  });
});
