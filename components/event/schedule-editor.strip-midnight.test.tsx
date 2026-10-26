// 2026-10-27 (hunt 3): the call sheet's summary strip ("N รายการ 18:00–01:30") took the
// earliest start and the latest end by plain string compare, so a day that runs past
// midnight read backwards - "00:30–22:30" for an 18:00 → 01:30 day - on the strip above
// a timeline that already reads the day in its own order (lib/clone-event.ts
// dayOrderSeconds round the stage). The strip now reads it the same way.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { makeSession, makeSupabaseFake } from "@/test/fakes/supabase";
import type { ScheduleItem } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ScheduleEditor } from "./schedule-editor";

const r = (
  id: string,
  kind: ScheduleItem["kind"],
  start: string,
  end: string | null,
  sort: number
): ScheduleItem => ({
  id,
  tenant_id: "t1",
  event_id: "e1",
  kind,
  label: null,
  location: null,
  start_time: start,
  end_time: end,
  notes: null,
  sort_order: sort,
});

afterEach(() => cleanup());

function strip(items: ScheduleItem[], editable: boolean) {
  h.supa = makeSupabaseFake({ session: makeSession() });
  const { container } = render(
    <ConfirmProvider>
      <ScheduleEditor eventId="e1" tenantId="t1" editable={editable} eventName="งานดึก" initialItems={items} />
    </ConfirmProvider>
  );
  return container.querySelector(".well")?.textContent ?? "";
}

const lateDay = [
  r("a", "on_location", "18:00:00", null, 1),
  r("b", "stage", "22:00:00", "22:30:00", 2),
  r("c", "booth", "00:30:00", "01:30:00", 3),
];

describe("ScheduleEditor · the summary strip on a day past midnight", () => {
  it("reads 18:00–01:30 for a day from 18:00 to a 01:30 booth (members' view)", () => {
    const text = strip(lateDay, false);
    expect(text).toContain("18:00–01:30");
    expect(text).not.toContain("00:30–");
  });

  it("…and the same on the Ar's editable sheet", () => {
    expect(strip(lateDay, true)).toContain("18:00–01:30");
  });

  it("a set that itself ends after midnight ends the day", () => {
    const text = strip(
      [r("a", "sound_check", "20:00:00", "20:30:00", 1), r("b", "stage", "23:30:00", "00:15:00", 2)],
      false
    );
    expect(text).toContain("20:00–00:15");
  });

  it("an ordinary afternoon is unchanged", () => {
    const text = strip(
      [r("a", "on_location", "12:00:00", null, 1), r("b", "stage", "15:00:00", "15:30:00", 2), r("c", "booth", "16:00:00", "17:00:00", 3)],
      false
    );
    expect(text).toContain("12:00–17:00");
  });
});
