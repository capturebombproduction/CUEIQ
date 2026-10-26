// A show with two named ถ่ายรูป rounds (mig 0042) shows BOTH on the board and in
// the crew JPG; the page carries the second one in photoMore (lib/photo-rounds.ts).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import {
  OverviewClient,
  type OverviewBand,
  type OverviewEvent,
} from "@/components/overview/overview-client";

vi.mock("@/lib/export-image", () => ({ captureElementToImage: vi.fn(async () => "") }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const SEISHIN = "11111111-1111-4111-8111-111111111111";
const TODAY = "2026-10-01";

const EV: OverviewEvent = {
  id: "two-costumes",
  name: "Two Costume Fest",
  group_id: SEISHIN,
  group_name: "Seishin Kakumei",
  group_color: "#A62A1C",
  exempt_from_deadline: false,
  event_date: TODAY,
  status: "approved",
  deadline: null,
  stage: { start: "14:00", end: "14:20" },
  booth: null,
  photo: "13:00",
  photoEnd: "13:15",
  photoMore: [{ start: "16:00", end: "16:15", label: "รอบ 2" }],
  tenant_id: "33333333-3333-4333-8333-333333333333",
  canEditPhoto: false,
  photoItemId: "main",
  photoSortOrder: 6,
  copyrightPending: 0,
  copyrightRejected: 0,
  incomplete: 0,
  missingLabels: [],
  notes: null,
};

const BANDS: OverviewBand[] = [
  { id: SEISHIN, name: "Seishin Kakumei", color: "#A62A1C", contact_name: null, contact_phone: null, members: [] },
];

function mount(events: OverviewEvent[]) {
  return render(
    <OverviewClient
      events={events}
      bands={BANDS}
      staffContacts={[]}
      labelName="A Lot Of Tone"
      canApproveEvents
      isLabelWide
      canOpenDetail
      todayKey={TODAY}
    />
  );
}

const exportBlock = (c: HTMLElement) => c.querySelector<HTMLElement>("div.fixed[aria-hidden]")!;

afterEach(() => cleanup());

describe("Overview — two photo rounds", () => {
  it("the board shows the main call and the named second round", () => {
    const { container } = mount([EV]);
    const text = container.textContent ?? "";
    expect(text).toContain("13:00–13:15");
    expect(text).toContain("16:00–16:15 · รอบ 2");
  });

  it("the crew JPG carries both rounds", () => {
    const { container } = mount([EV]);
    const text = exportBlock(container)?.textContent ?? "";
    expect(text).toContain("13:00–13:15");
    expect(text).toContain("16:00–16:15 · รอบ 2");
  });

  it("one round prints exactly as before", () => {
    const { container } = mount([{ ...EV, photoMore: [] }]);
    expect(container.textContent).toContain("13:00–13:15");
    expect(container.textContent).not.toContain("รอบ 2");
  });
});
