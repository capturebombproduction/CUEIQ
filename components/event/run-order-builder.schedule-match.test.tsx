import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { RunOrderBuilder, type RunSequence, type RunBandEvent } from "./run-order-builder";

// ─────────────────────────────────────────────────────────────────────────────
// AN ACT'S TIME, IN TWO PLACES (2026-10-30, hunt 11).
//
// A festival act's stage time lives on the board line (run_sequence.planned_start - what
// the caller calls) AND in the band's own schedule (the stage row - what the band's Live
// clock, call time and reminders read). "นำเข้าจากเวทีวง" copied one into the other once;
// after that an edit on either side left the other stale and nothing on the builder said
// so. And the link dropdown's tooltip promised "ดึงเวลา" while a manual link pulled no
// time at all. Now: a linked line whose time is none of its band's slots wears a chip,
// and linking a line that has NO time fills it from the band's slot (a timed line keeps
// its time - the chip says it disagrees).
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const FEST = "A Lot Of Tone Fest";

function seq(over: Partial<RunSequence> & { id: string }): RunSequence {
  return {
    tenant_id: "t1",
    event_name: FEST,
    event_date: "2026-08-09",
    sort_order: 1,
    title: "",
    kind: "band",
    planned_start: null,
    planned_end: null,
    buffer_seconds: 0,
    linked_event_id: null,
    ...over,
  };
}

const BANDS: RunBandEvent[] = [
  { id: "ev-sk", group_name: "Seishin Kakumei", stage_start: "16:10:00", stage_end: "16:15:00" },
  { id: "ev-km", group_name: "KŌMA", stage_start: "16:05:00", stage_end: "16:10:00" },
  // a band booked twice that day
  { id: "ev-hb", group_name: "HatoBito", stage_start: "12:00:00", stage_end: "12:20:00" },
  { id: "ev-hb", group_name: "HatoBito", stage_start: "16:40:00", stage_end: "17:10:00" },
];

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  supa.setTable("run_sequence", (call) =>
    call.verb === "select" ? ok([]) : ok([{ id: call.eq.id }])
  );
  h.supa = supa;
});

function renderBuilder(rows: RunSequence[]) {
  return render(
    <ConfirmProvider>
      <RunOrderBuilder
        tenantId="t1"
        eventName={FEST}
        eventDate="2026-08-09"
        initial={rows}
        bandEvents={BANDS}
      />
    </ConfirmProvider>
  );
}

const chips = (c: HTMLElement) => Array.from(c.querySelectorAll("[data-cueiq-off-schedule]"));
/** The band-link select of the row at `i` (two selects per row: kind, then link). */
const linkSelect = (c: HTMLElement, i: number) => c.querySelectorAll("select")[i * 2 + 1];

describe("RunOrderBuilder — a line whose time is not its band's slot says so", () => {
  it("shows the chip, with the band's slot time, on a linked line moved off its slot", () => {
    const { container } = renderBuilder([
      seq({ id: "r1", title: "Seishin Kakumei", planned_start: "16:40:00", linked_event_id: "ev-sk" }),
    ]);
    const [chip] = chips(container);
    expect(chip, "no chip on a line the band's schedule disagrees with").toBeDefined();
    expect(chip.textContent).toContain("เวลาไม่ตรงกับตารางวง");
    expect(chip.textContent).toContain("16:10");
    expect(chip.getAttribute("title")).toContain("16:10");
  });

  it("no chip when the line's time is the band's slot - including the second slot of a twice-booked band", () => {
    const { container } = renderBuilder([
      seq({ id: "r1", sort_order: 1, planned_start: "16:10", linked_event_id: "ev-sk" }),
      seq({ id: "r2", sort_order: 2, planned_start: "16:40:00", linked_event_id: "ev-hb" }),
    ]);
    expect(chips(container)).toHaveLength(0);
  });

  it("no chip on an unlinked line, a linked line with no time, or a band with no stage time", () => {
    const { container } = render(
      <ConfirmProvider>
        <RunOrderBuilder
          tenantId="t1"
          eventName={FEST}
          eventDate="2026-08-09"
          initial={[
            seq({ id: "r1", sort_order: 1, title: "Chocolatière (guest)", planned_start: "15:50:00" }),
            seq({ id: "r2", sort_order: 2, linked_event_id: "ev-sk" }),
            seq({ id: "r3", sort_order: 3, planned_start: "18:00:00", linked_event_id: "ev-x" }),
          ]}
          bandEvents={[...BANDS, { id: "ev-x", group_name: "TERASHI", stage_start: null, stage_end: null }]}
        />
      </ConfirmProvider>
    );
    expect(chips(container)).toHaveLength(0);
  });

  it("drawing the chip writes nothing", async () => {
    renderBuilder([seq({ id: "r1", planned_start: "16:40:00", linked_event_id: "ev-sk" })]);
    await act(async () => {});
    expect(supa.callsTo("run_sequence", "update")).toHaveLength(0);
    expect(supa.callsTo("run_sequence", "insert")).toHaveLength(0);
  });
});

describe("RunOrderBuilder — linking a band pulls its time, as the tooltip says", () => {
  it("a line with no time takes the band's slot (start and end) in the same write", async () => {
    const { container } = renderBuilder([seq({ id: "r1", title: "Seishin Kakumei" })]);
    fireEvent.change(linkSelect(container, 0), { target: { value: "ev-sk" } });
    await waitFor(() => expect(supa.callsTo("run_sequence", "update")).toHaveLength(1));
    const [u] = supa.callsTo("run_sequence", "update");
    expect(u.eq).toMatchObject({ id: "r1" });
    expect(u.values).toEqual({
      linked_event_id: "ev-sk",
      planned_start: "16:10:00",
      planned_end: "16:15:00",
    });
    expect((container.querySelectorAll('input[type="time"]')[0] as HTMLInputElement).value).toBe("16:10");
    expect(chips(container)).toHaveLength(0);
  });

  it("a twice-booked band gives the slot no other line of it already stands on", async () => {
    const { container } = renderBuilder([
      seq({ id: "r1", sort_order: 1, planned_start: "12:00:00", planned_end: "12:20:00", linked_event_id: "ev-hb" }),
      seq({ id: "r2", sort_order: 2, title: "HatoBito (รอบ 2)" }),
    ]);
    fireEvent.change(linkSelect(container, 1), { target: { value: "ev-hb" } });
    await waitFor(() => expect(supa.callsTo("run_sequence", "update")).toHaveLength(1));
    expect(supa.callsTo("run_sequence", "update")[0].values).toEqual({
      linked_event_id: "ev-hb",
      planned_start: "16:40:00",
      planned_end: "17:10:00",
    });
  });

  it("a line that already has a time keeps it - only the link is written, and the chip shows", async () => {
    const { container } = renderBuilder([
      seq({ id: "r1", planned_start: "16:40:00", planned_end: "16:45:00" }),
    ]);
    fireEvent.change(linkSelect(container, 0), { target: { value: "ev-sk" } });
    await waitFor(() => expect(supa.callsTo("run_sequence", "update")).toHaveLength(1));
    expect(supa.callsTo("run_sequence", "update")[0].values).toEqual({ linked_event_id: "ev-sk" });
    expect(chips(container)).toHaveLength(1);
  });

  it("unlinking writes only the link", async () => {
    const { container } = renderBuilder([
      seq({ id: "r1", planned_start: "16:10:00", linked_event_id: "ev-sk" }),
    ]);
    fireEvent.change(linkSelect(container, 0), { target: { value: "" } });
    await waitFor(() => expect(supa.callsTo("run_sequence", "update")).toHaveLength(1));
    expect(supa.callsTo("run_sequence", "update")[0].values).toEqual({ linked_event_id: null });
  });
});
