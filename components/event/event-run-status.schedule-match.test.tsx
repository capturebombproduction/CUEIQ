import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, fail, type SupabaseFake } from "@/test/fakes/supabase";
import type { RunSeqLive } from "@/components/event/event-live-caller";
import { EventRunStatusCard, offBandSchedule } from "./event-run-status";

// ─────────────────────────────────────────────────────────────────────────────
// THE BAND'S PAGE, WITH TWO STAGE TIMES ON IT (2026-10-30, hunt 11).
//
// This card tells a band "คิวคุณ — รอเล่น · คาดเริ่ม 16:40" from the festival board's
// line, while the same page's hero, the dashboard ticket, the reminders and Live all
// read the band's own stage row. Nothing keeps the two in step: staff re-timing the board
// line, or the band's Ar moving its stage row, left one of them stale, and the page
// showed two different times with nothing saying which to believe. The card now says so
// - and only says so: nothing is moved, and a failed read paints nothing.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

const EVENT_ID = "9f3a1c8e-2b4d-4a91-8c7e-1f2a3b4c5d6e";

function seqRow(over: Partial<RunSeqLive> = {}): RunSeqLive {
  return {
    id: "r1",
    sort_order: 1,
    title: "Seishin Kakumei",
    kind: "band",
    planned_start: "16:10:00",
    planned_end: "16:15:00",
    buffer_seconds: 0,
    linked_event_id: EVENT_ID,
    actual_start: null,
    actual_end: null,
    status: "pending",
    offset_min: null,
    ...over,
  };
}

let supa: SupabaseFake;
function setup(stage: ReturnType<typeof ok>) {
  supa = makeSupabaseFake({
    session: makeSession(),
    script: { run_sequence: ok([]), schedule_items: stage },
  });
  h.supa = supa;
}
beforeEach(() => setup(ok([{ start_time: "16:10:00" }])));

async function renderCard(rows: RunSeqLive[]) {
  const r = render(
    <EventRunStatusCard
      rows={rows}
      selfEventId={EVENT_ID}
      tenantId="t1"
      eventName="SPORT DAY"
      eventDate="2026-07-04"
    />
  );
  await act(async () => {});
  return r;
}

const hint = () => document.querySelector("[data-cueiq-off-schedule]");

describe("EventRunStatusCard — says when the board's time is not the band's", () => {
  it("names both times when staff moved the band's line off its stage time", async () => {
    await renderCard([seqRow({ planned_start: "16:40:00", planned_end: "16:45:00" })]);
    expect(hint(), "the band sees two stage times and nothing says so").not.toBeNull();
    expect(hint()!.textContent).toContain("16:40");
    expect(hint()!.textContent).toContain("16:10");
    // it reads the band's OWN stage row, scoped to this event
    const [read] = supa.callsTo("schedule_items", "select");
    expect(read.eq).toMatchObject({ event_id: EVENT_ID, kind: "stage" });
  });

  it("says nothing when the two agree - the normal case", async () => {
    await renderCard([seqRow()]);
    expect(hint()).toBeNull();
  });

  it("says nothing when the band's schedule could not be read", async () => {
    setup(fail("canceling statement due to statement timeout", 500));
    await renderCard([seqRow({ planned_start: "16:40:00" })]);
    expect(hint()).toBeNull();
    // and asks auth nothing for it (the card's reconnect contract)
    expect(supa.auth.getSession).not.toHaveBeenCalled();
  });

  it("says nothing once the slot is on stage", async () => {
    await renderCard([
      seqRow({ planned_start: "16:40:00", status: "live", actual_start: "2026-07-04T16:41:00+07:00" }),
    ]);
    expect(hint()).toBeNull();
  });

  it("writes nothing", async () => {
    await renderCard([seqRow({ planned_start: "16:40:00" })]);
    expect(supa.calls.filter((c) => c.verb !== "select")).toEqual([]);
  });
});

describe("offBandSchedule", () => {
  it("compares on the clock, whatever the seconds", () => {
    expect(offBandSchedule("16:10", ["16:10:00"])).toBeNull();
    expect(offBandSchedule("16:40:00", ["16:10:00", "16:10:00"])).toEqual(["16:10"]);
    expect(offBandSchedule("16:40:00", ["12:00:00", "16:40:00"])).toBeNull();
  });
  it("has nothing to say without a time on either side", () => {
    expect(offBandSchedule(null, ["16:10:00"])).toBeNull();
    expect(offBandSchedule("16:40:00", [])).toBeNull();
    expect(offBandSchedule("16:40:00", [null])).toBeNull();
  });
});
