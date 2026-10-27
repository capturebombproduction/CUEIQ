// The approver's copyright triage on the event page, against a song that moved on
// (2026-10-27, hunt 8). The write used to filter on the song id alone: approver B's page,
// still showing "รอตรวจ", turned approver A's ปฏิเสธ into อนุมัติ and the band was told
// both. And the guard's English ("only an approver may change copyright_status") reached
// the toast of an approver demoted to a band Ar while the page stayed open.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";

const db = vi.hoisted(() => ({
  eqs: [] as [string, unknown][],
  write: { data: [{ id: "s1" }] as unknown[] | null, error: null as unknown },
  row: null as Record<string, unknown> | null,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      let mode: "read" | "write" = "read";
      const b = {
        update: () => ((mode = "write"), b),
        eq: (c: string, v: unknown) => {
          if (mode === "write") db.eqs.push([c, v]);
          return b;
        },
        is: (c: string, v: unknown) => {
          if (mode === "write") db.eqs.push([c, v]);
          return b;
        },
        select: () => (mode === "write" ? Promise.resolve(db.write) : b),
        maybeSingle: () => Promise.resolve({ data: db.row, error: null }),
      };
      return b;
    },
  }),
}));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify-client", () => ({ notify }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));

import { EventCopyrightPanel } from "./event-copyright-panel";

const PENDING = [{ id: "s1", title: "Kakumei", copyright_status: "pending" as const }];

beforeEach(() => {
  db.eqs = [];
  db.write = { data: [{ id: "s1" }], error: null };
  db.row = null;
  notify.mockReset();
  toast.error.mockReset();
});

describe("EventCopyrightPanel triage of a song that moved on", () => {
  it("writes only over the status and title this page showed", async () => {
    const { getByText } = render(<EventCopyrightPanel songs={PENDING} />);
    fireEvent.click(getByText("อนุมัติ"));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("song_cleared", { songId: "s1" }));
    expect(db.eqs).toContainEqual(["copyright_status", "pending"]);
    expect(db.eqs).toContainEqual(["title", "Kakumei"]);
  });

  it("another approver's ปฏิเสธ: says so, shows it, and tells the band nothing", async () => {
    db.write = { data: [], error: null };
    db.row = { copyright_status: "rejected", title: "Kakumei", audio_path: "t/g/s1/a.wav" };
    const { getByText, container } = render(<EventCopyrightPanel songs={PENDING} />);
    fireEvent.click(getByText("อนุมัติ"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("สถานะลิขสิทธิ์ของเพลงนี้เปลี่ยนไปแล้ว", expect.anything())
    );
    expect(notify).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector(".chip")?.textContent).toBe("ถูกปฏิเสธ"));
  });

  it("already what was asked (another approver): no error and no second notice", async () => {
    db.write = { data: [], error: null };
    db.row = { copyright_status: "cleared", title: "Kakumei", audio_path: null };
    const { getByText } = render(<EventCopyrightPanel songs={PENDING} />);
    fireEvent.click(getByText("อนุมัติ"));
    await waitFor(() => expect(db.eqs.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(toast.error).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("says the guard's refusal in Thai", async () => {
    db.write = { data: null, error: { code: "P0001", message: "only an approver may change copyright_status" } };
    const { getByText } = render(<EventCopyrightPanel songs={PENDING} />);
    fireEvent.click(getByText("อนุมัติ"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const desc = (toast.error.mock.calls[0][1] as { description?: string }).description ?? "";
    expect(desc).not.toMatch(/only an approver/);
    expect(desc).toMatch(/ทีมค่าย\/แอดมิน/);
    expect(notify).not.toHaveBeenCalled();
  });
});
