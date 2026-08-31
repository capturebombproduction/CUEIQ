// THE APPROVAL QUEUE AS A PLACE YOU CAN LOOK.
//
// "Gorya seitan sai" sat at pending_review from 15 July, for a 19 July show, and
// was still there on 31 August. It was on THIS BOARD the whole time — visible,
// one tap from approval — inside a fifty-row list with nothing that said how many
// were waiting. The daily cron reminds approvers about shows still ahead; it can
// never help one whose date has passed. This chip is the other half.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import {
  OverviewClient,
  type OverviewBand,
  type OverviewEvent,
} from "@/components/overview/overview-client";

// The export button reaches for html-to-image; nothing here clicks it, and loading
// the real one costs a large dependency in every run of this file.
vi.mock("@/lib/export-image", () => ({ captureElementToImage: vi.fn(async () => "") }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const SEISHIN = "11111111-1111-4111-8111-111111111111";
const KOMA = "22222222-2222-4222-8222-222222222222";

function ev(over: Partial<OverviewEvent> & { id: string }): OverviewEvent {
  return {
    name: "งาน",
    group_id: SEISHIN,
    group_name: "Seishin Kakumei",
    group_color: null,
    exempt_from_deadline: false,
    event_date: "2026-08-20",
    status: "approved",
    deadline: null,
    stage: { start: "19:00", end: "19:30" },
    booth: null,
    photo: null,
    photoEnd: null,
    tenant_id: "33333333-3333-4333-8333-333333333333",
    canEditPhoto: false,
    photoItemId: null,
    photoSortOrder: 0,
    copyrightPending: 0,
    copyrightRejected: 0,
    incomplete: 0,
    missingLabels: [],
    notes: null,
    ...over,
  };
}

const BANDS: OverviewBand[] = [
  {
    id: SEISHIN,
    name: "Seishin Kakumei",
    color: null,
    contact_name: null,
    contact_phone: null,
    members: [],
  },
  { id: KOMA, name: "KŌMA", color: null, contact_name: null, contact_phone: null, members: [] },
];

// The real shape of the problem: one waiting submission whose show has already
// happened, plus an ordinary approved show, plus a waiting one on another band.
const GORYA = ev({
  id: "gorya",
  name: "Gorya seitan sai",
  event_date: "2026-07-19",
  status: "pending_review",
});
const DONE = ev({ id: "done", name: "Vasa seitan", event_date: "2026-08-23" });
const OTHER_BAND = ev({
  id: "koma",
  name: "KŌMA one man",
  group_id: KOMA,
  group_name: "KŌMA",
  status: "pending_review",
});

function mount(events: OverviewEvent[], canApproveEvents = true) {
  return render(
    <OverviewClient
      events={events}
      bands={BANDS}
      staffContacts={[]}
      labelName="A Lot Of Tone"
      canApproveEvents={canApproveEvents}
      isLabelWide
      canOpenDetail
    />
  );
}

/** The on-screen board only — the component also renders an off-screen copy of
 *  every row for the JPG export, so a bare getAllByText would double-count. */
function boardNames(): string[] {
  const chip = screen.getByTestId("approval-queue-chip");
  // The visible board is the chip's own scrollable region: walk up to the card
  // that holds both the toolbar and the tables.
  const board = chip.closest("div.space-y-4") ?? document.body;
  return Array.from(board.querySelectorAll("a, td"))
    .map((n) => n.textContent?.trim() ?? "")
    .filter(Boolean);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("the approval queue chip", () => {
  it("counts every waiting submission, across all bands", () => {
    mount([GORYA, DONE, OTHER_BAND]);
    expect(screen.getByTestId("approval-queue-chip")).toHaveTextContent("รออนุมัติ 2");
  });

  it("is not shown to someone who cannot approve", () => {
    mount([GORYA, DONE], false);
    expect(screen.queryByTestId("approval-queue-chip")).toBeNull();
  });

  it("is not shown when nothing is waiting — a chip reading 0 is furniture", () => {
    mount([DONE], true);
    expect(screen.queryByTestId("approval-queue-chip")).toBeNull();
  });

  // THE WHOLE POINT. A past-dated submission is exactly the one the cron cannot
  // reach, so if the chip skipped it the queue would still be invisible.
  it("filters the board down to the waiting ones, INCLUDING a show that has passed", () => {
    mount([GORYA, DONE, OTHER_BAND]);
    const chip = screen.getByTestId("approval-queue-chip");
    expect(chip).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(chip);
    expect(screen.getByTestId("approval-queue-chip")).toHaveAttribute("aria-pressed", "true");

    const shown = boardNames().join(" | ");
    expect(shown).toContain("Gorya seitan sai");
    expect(shown).toContain("KŌMA one man");
    expect(shown).not.toContain("Vasa seitan");
  });

  it("restores the full board when switched off again", () => {
    mount([GORYA, DONE, OTHER_BAND]);
    const chip = screen.getByTestId("approval-queue-chip");
    fireEvent.click(chip);
    fireEvent.click(screen.getByTestId("approval-queue-chip"));
    expect(screen.getByTestId("approval-queue-chip")).toHaveAttribute("aria-pressed", "false");
    expect(boardNames().join(" | ")).toContain("Vasa seitan");
  });

  // Written first as "the queue ignores the band filter", which is what `filtered`
  // does — and it FAILED, because in รายวง mode the board's sections are built from
  // bandFilter too, so one band's filter still hid a row the chip was counting.
  // The cure is that switching the queue on clears the filters, which also makes
  // the selects say what is actually on screen.
  it("clears the band filter, so the list always matches the number on the chip", () => {
    mount([GORYA, DONE, OTHER_BAND]);
    const bandSelect = screen.getAllByRole("combobox").at(-1)! as HTMLSelectElement;
    fireEvent.change(bandSelect, { target: { value: KOMA } });
    expect(bandSelect.value).toBe(KOMA);
    // The count speaks for the whole label even while a band filter is on.
    expect(screen.getByTestId("approval-queue-chip")).toHaveTextContent("รออนุมัติ 2");

    fireEvent.click(screen.getByTestId("approval-queue-chip"));

    expect((screen.getAllByRole("combobox").at(-1) as HTMLSelectElement).value).toBe("all");
    const shown = boardNames().join(" | ");
    expect(shown).toContain("Gorya seitan sai");
    expect(shown).toContain("KŌMA one man");
    expect(shown).not.toContain("Vasa seitan");
  });

  // queueActive is derived (`queueOnly && pendingCount > 0`) rather than stored,
  // precisely so that approving the last one cannot leave the viewer staring at an
  // empty board with the chip already gone and no way to switch it back off.
  it("cannot strand the viewer on an empty board when the last one is approved", () => {
    const { rerender } = mount([GORYA, DONE]);
    fireEvent.click(screen.getByTestId("approval-queue-chip"));
    expect(boardNames().join(" | ")).not.toContain("Vasa seitan");

    // …the approval lands and the row is no longer pending.
    rerender(
      <OverviewClient
        events={[{ ...GORYA, status: "approved" }, DONE]}
        bands={BANDS}
        staffContacts={[]}
        labelName="A Lot Of Tone"
        canApproveEvents
        isLabelWide
        canOpenDetail
      />
    );
    expect(screen.queryByTestId("approval-queue-chip")).toBeNull();
    // The board is whole again, not empty.
    const body = within(document.body);
    expect(body.getAllByText(/Vasa seitan/).length).toBeGreaterThan(0);
  });
});
