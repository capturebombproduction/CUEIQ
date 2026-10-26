import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import SharePage from "@/app/share/[token]/page";

// 2026-10-27 (hunt 6): the public run sheet (/share/<token>) lists the day in the order
// the in-app run sheet and its JPG read it (components/event/event-summary.tsx) - round
// the stage, earliest first, a row with no time last, ties as the band ordered them.
// get_shared_event hands the rows back by sort_order, the order they were ADDED, and the
// page printed them as they came: a call sheet built Stage-first sent the crew Stage
// 18:00 above Call 16:00, and a 00:30 booth after a 23:00 set above everything.
const h = vi.hoisted(() => ({ bundle: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async () => ({ data: h.bundle, error: null }),
  }),
}));

type Row = {
  id: string;
  kind: string;
  label: string | null;
  start_time: string | null;
  sort_order: number;
};
const row = (r: Row) => ({ location: null, end_time: null, notes: null, ...r });

async function mount(schedule: ReturnType<typeof row>[], showStart: string | null) {
  h.bundle = {
    event: {
      id: "e1",
      name: "A Lot Of Tone Fest",
      event_date: "2026-10-10",
      venue: null,
      event_type: "concert",
      show_start_time: showStart,
      hard_out_time: null,
      status: "approved",
      notes: null,
      map_url: null,
      costume_theme: null,
    },
    group: { id: "g1", name: "Seishin Kakumei", color: null, skin: null },
    schedule,
    setlist: [],
    members: [],
  };
  const ui = await SharePage({ params: Promise.resolve({ token: "tok" }) });
  return render(ui);
}

/** The schedule section's rows, top to bottom, by their time column. */
function times(container: HTMLElement): string[] {
  const section = Array.from(container.querySelectorAll("section")).find((s) =>
    s.textContent?.includes("กำหนดการ / นัดหมาย")
  );
  expect(section, "the schedule section").toBeTruthy();
  return Array.from(section!.querySelectorAll("li > span:first-child")).map((el) => el.textContent ?? "");
}

describe("Share page · the day in the run sheet's order", () => {
  it("earliest first, whatever order the rows were added in", async () => {
    const { container } = await mount(
      [
        row({ id: "a", kind: "stage", label: null, start_time: "18:00:00", sort_order: 1 }),
        row({ id: "b", kind: "on_location", label: null, start_time: "16:00:00", sort_order: 2 }),
        row({ id: "c", kind: "photo", label: null, start_time: "17:00:00", sort_order: 3 }),
      ],
      "18:00:00"
    );
    expect(times(container)).toEqual(["16:00", "17:00", "18:00"]);
  });

  it("an after-midnight booth after a late set is the END of the day, and an untimed row is last", async () => {
    const { container } = await mount(
      [
        row({ id: "a", kind: "booth", label: null, start_time: "00:30:00", sort_order: 1 }),
        row({ id: "b", kind: "other", label: "โน้ตทั่วไป", start_time: null, sort_order: 2 }),
        row({ id: "c", kind: "stage", label: null, start_time: "23:00:00", sort_order: 3 }),
        row({ id: "d", kind: "on_location", label: null, start_time: "21:00:00", sort_order: 4 }),
      ],
      "23:00:00"
    );
    expect(times(container)).toEqual(["21:00", "23:00", "00:30", "—"]);
  });

  it("rows at the same time keep the band's own order", async () => {
    const { container } = await mount(
      [
        row({ id: "z", kind: "other", label: "สอง", start_time: "15:00:00", sort_order: 2 }),
        row({ id: "y", kind: "other", label: "หนึ่ง", start_time: "15:00:00", sort_order: 1 }),
      ],
      "18:00:00"
    );
    const section = Array.from(container.querySelectorAll("section")).find((s) =>
      s.textContent?.includes("กำหนดการ / นัดหมาย")
    )!;
    const names = Array.from(section.querySelectorAll("li > span:nth-child(2)")).map((el) => el.textContent);
    expect(names).toEqual(["หนึ่ง", "สอง"]);
  });
});
