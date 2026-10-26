// A timed named photo round behind a main round with no time yet.
//
// photoRoundsOf() makes the unnamed/"ถ่ายรูป" round the MAIN one even when it has no
// time yet (photos.findIndex(isMainPhotoRound)), and every Photo surface keys on the
// main round's start only - hasPhoto used to be !!ev.photo, which decided
// which acts the board's Photo table AND the crew JPG list. So a show whose named
// round "ชุด 2" HAS a time while the plain "ถ่ายรูป" row is still blank (a copied
// schedule, or label staff not having filled it yet) is missing from the Photo table
// for everyone who cannot edit it (members, CEO, a self_photo band) and from the JPG
// the crew is handed - the 16:00 call exists in the DB and nowhere on the board.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import {
  OverviewClient,
  type OverviewBand,
  type OverviewEvent,
} from "@/components/overview/overview-client";
import { photoRoundsOf } from "@/lib/photo-rounds";

vi.mock("@/lib/export-image", () => ({ captureElementToImage: vi.fn(async () => "") }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const SEISHIN = "11111111-1111-4111-8111-111111111111";
const TODAY = "2026-10-01";

// The page builds the event from photoRoundsOf exactly like this (page.tsx:445-467).
const rows = [
  { id: "p-main", kind: "photo", label: "ถ่ายรูป", start_time: null, end_time: null, sort_order: 3 },
  { id: "p-2", kind: "photo", label: "ชุด 2", start_time: "16:00:00", end_time: "16:15:00", sort_order: 4 },
];
const { main, more } = photoRoundsOf(rows);

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
  photo: main?.start_time ?? null,
  photoEnd: main?.end_time ?? null,
  photoMore: more,
  tenant_id: "33333333-3333-4333-8333-333333333333",
  canEditPhoto: false, // a member / CEO / self_photo band: read-only photo cell
  photoItemId: main?.id ?? null,
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

function mount() {
  return render(
    <OverviewClient
      events={[EV]}
      bands={BANDS}
      staffContacts={[]}
      labelName="A Lot Of Tone"
      canApproveEvents={false}
      isLabelWide
      canOpenDetail
      todayKey={TODAY}
    />
  );
}

const exportBlock = (c: HTMLElement) => c.querySelector<HTMLElement>("div.fixed[aria-hidden]");

afterEach(() => cleanup());

describe("a timed named photo round behind an untimed main round", () => {
  it("the board shows the 16:00 'ชุด 2' photo call", () => {
    const { container } = mount();
    expect(container.textContent ?? "").toContain("16:00–16:15 · ชุด 2");
  });

  it("the crew JPG carries the 16:00 'ชุด 2' photo call", () => {
    const { container } = mount();
    expect(exportBlock(container)?.textContent ?? "").toContain("16:00–16:15 · ชุด 2");
  });
});
