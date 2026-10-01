// The Training landing (spec §G.6): one lit "continue" hero for the room someone
// practised in last, then every room as a slab that says what is waiting in it.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

vi.mock("next/navigation", () => ({
  usePathname: () => "/practice",
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { PracticeRoomList, type PracticeRoomRow } from "./practice-room-list";
import type { PracticeRoomStats } from "./practice-room-stats";

const rooms: PracticeRoomRow[] = [
  { id: "r1", name: "ห้องซ้อม — RED REVOLUTION", group_id: "g1", groups: { name: "Seishin Kakumei", color: "#a62a1c" } },
  { id: "r2", name: "ห้องซ้อม — เพลงใหม่ Q4", group_id: "g1", groups: { name: "Seishin Kakumei", color: "#a62a1c" } },
];
const TODAY = "2026-09-30";

const mount = (stats?: Record<string, PracticeRoomStats>, deletable: string[] = []) =>
  render(
    <ConfirmProvider>
      <PracticeRoomList rooms={rooms} stats={stats} deletableIds={deletable} todayKey={TODAY} />
    </ConfirmProvider>
  );

describe("PracticeRoomList", () => {
  it("lights the room practised in last as the one hero, with its last run and its counts", () => {
    const { container } = mount({
      r1: { songs: 5, homework: 1, problems: 2, lastRun: { at: "2026-09-29T06:20:00Z", title: "Akai Hana", speed: 1 } },
      r2: { songs: 3, homework: 0, problems: 0, lastRun: { at: "2026-09-30T06:20:00Z", title: "Neon Samurai", speed: 0.75 } },
    });
    expect(container.querySelectorAll(".lit")).toHaveLength(1);
    const hero = screen.getByRole("region", { name: "Continue practising" });
    expect(within(hero).getByRole("heading", { name: "ห้องซ้อม — เพลงใหม่ Q4" })).toBeTruthy();
    expect(hero.textContent).toContain("ล่าสุด 13:20 · Neon Samurai ที่ 0.75×");
    expect(within(hero).getByText("ซ้อมวันนี้")).toBeTruthy();
    expect(within(hero).getByRole("link", { name: /ซ้อมต่อ/ }).getAttribute("href")).toBe("/events/r2/practice");
  });

  it("each room says only the counts it knows and that are above zero", () => {
    mount({
      r1: { songs: 5, homework: 1, problems: 2, lastRun: null },
      r2: { songs: 0, homework: 0, problems: 0, lastRun: null },
    });
    const [first, second] = screen.getAllByRole("listitem");
    expect(first.textContent).toMatch(/5\s*เพลง/);
    expect(first.textContent).toMatch(/การบ้าน\s*1/);
    expect(first.textContent).toMatch(/ปัญหา\s*2/);
    expect(second.textContent).not.toMatch(/\d\s*เพลง|การบ้าน|ปัญหา/);
  });

  it("with no stats (still loading, offline) the rooms still list — no hero, no made-up numbers", () => {
    const { container } = mount(undefined);
    expect(container.querySelector(".lit")).toBeNull();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByRole("link").getAttribute("href")).toBe("/events/r1/practice");
    expect(items[0].textContent).not.toMatch(/\d\s*เพลง|การบ้าน|ปัญหา/);
  });

  it("delete sits behind the room's ⋯ as a dashed outline, and only where allowed", () => {
    mount(undefined, ["r1"]);
    const [first, second] = screen.getAllByRole("listitem");
    expect(within(second).queryByRole("button")).toBeNull();
    fireEvent.click(within(first).getByRole("button", { name: /ตัวเลือกห้องซ้อม/ }));
    const del = within(screen.getByRole("dialog")).getByRole("button", { name: /ลบห้องซ้อม/ });
    expect(del.className).toMatch(/border-dashed/);
  });
});
