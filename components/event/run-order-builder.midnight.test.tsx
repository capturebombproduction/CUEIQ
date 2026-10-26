import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake, type RecordedCall } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { RunOrderBuilder, type RunBandEvent } from "./run-order-builder";

// ─────────────────────────────────────────────────────────────────────────────
// "นำเข้าจากเวทีวง" ACROSS MIDNIGHT (2026-10-27 hunt, showrun-4).
//
// The import ordered the stage slots by their clock STRING. An evening festival whose
// closer plays after midnight (21:00, 22:00, 23:00, then 00:30) was seeded with the
// 00:30 band as row 1: the board's เริ่มงาน named it, the run-status card projected
// the evening from 00:30, and a band booked on both sides of midnight got its
// "(รอบ 1)" / "(รอบ 2)" the wrong way round. The day is a circle: the show begins
// after its longest quiet stretch.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

let supa: SupabaseFake;
const inserted: Record<string, unknown>[] = [];
beforeEach(() => {
  inserted.length = 0;
  supa = makeSupabaseFake({ session: makeSession() });
  supa.setTable("run_sequence", (call: RecordedCall) => {
    if (call.verb === "insert") {
      const v = { id: `n${inserted.length + 1}`, ...(call.values as Record<string, unknown>) };
      inserted.push(v);
      return ok(v);
    }
    return ok([]);
  });
  h.supa = supa;
});

const slot = (id: string, group_name: string, stage_start: string | null, stage_end: string | null = null): RunBandEvent => ({
  id,
  group_name,
  stage_start,
  stage_end,
});

/** Import every slot into an empty order; the titles in the order they were seeded. */
async function importInto(bands: RunBandEvent[], expected: number): Promise<string[]> {
  render(
    <ConfirmProvider>
      <RunOrderBuilder tenantId="t1" eventName="Night Fest" eventDate="2026-11-01" initial={[]} bandEvents={bands} />
    </ConfirmProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: /นำเข้าจากเวทีวง/ }));
  await waitFor(() => expect(inserted).toHaveLength(expected));
  return [...inserted].sort((a, b) => Number(a.sort_order) - Number(b.sort_order)).map((r) => String(r.title));
}

describe("RunOrderBuilder — นำเข้าจากเวทีวง orders the slots the way the day plays them", () => {
  it("an evening festival's after-midnight closer is seeded LAST, not first", async () => {
    const titles = await importInto(
      [
        slot("ev-close", "Closer", "00:30:00", "01:10:00"),
        slot("ev-a", "Opener", "21:00:00", "21:30:00"),
        slot("ev-b", "Seishin Kakumei", "22:00:00", "22:30:00"),
        slot("ev-c", "Third", "23:00:00", "23:40:00"),
      ],
      4
    );
    expect(titles).toEqual(["Opener", "Seishin Kakumei", "Third", "Closer"]);
  });

  it("a band booked on both sides of midnight plays รอบ 1 before midnight", async () => {
    const titles = await importInto(
      [
        slot("ev-s", "Seishin Kakumei", "00:45:00"),
        slot("ev-s", "Seishin Kakumei", "22:15:00"),
        slot("ev-x", "Guest", "23:30:00"),
      ],
      3
    );
    expect(titles).toEqual(["Seishin Kakumei (รอบ 1)", "Guest", "Seishin Kakumei (รอบ 2)"]);
    expect(inserted.find((r) => r.title === "Seishin Kakumei (รอบ 1)")?.planned_start).toBe("22:15:00");
  });

  it("an all-day show that runs past midnight still starts in the morning", async () => {
    // one anchor on the earliest slot (00:30) would put the evening sets before the morning
    const titles = await importInto(
      [
        slot("ev-8", "Late", "00:30:00"),
        slot("ev-1", "Morning", "10:00:00"),
        slot("ev-2", "Noon", "12:00:00"),
        slot("ev-3", "Afternoon", "15:00:00"),
        slot("ev-4", "Evening", "19:00:00"),
        slot("ev-5", "Night", "22:00:00"),
      ],
      6
    );
    expect(titles).toEqual(["Morning", "Noon", "Afternoon", "Evening", "Night", "Late"]);
  });

  it("(control) a show that never crosses midnight keeps the plain clock order", async () => {
    const titles = await importInto(
      [slot("ev-c", "C", "13:00:00"), slot("ev-a", "A", "10:00:00"), slot("ev-b", "B", "11:30:00")],
      3
    );
    expect(titles).toEqual(["A", "B", "C"]);
  });

  it("(control) a slot with no stage time is still not imported", async () => {
    const titles = await importInto([slot("ev-a", "A", "21:00:00"), slot("ev-n", "No time", null)], 1);
    expect(titles).toEqual(["A"]);
  });
});
