import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { skinCss } from "@/lib/skin";
import SharePage from "@/app/share/[token]/page";

// The public run sheet a venue opens from /share/<token>. It injects the band's skin
// (<BandSkin>), and lib/skin.ts moves --destructive OFF red for a band whose own
// colour is red, so an error never reads as the band. The page coloured
// "เกิน Hard out" with text-destructive, which made Seishin Kakumei's overtime warning
// violet (the delete colour) on the one public sheet. Overtime is the band-independent
// alarm (spec §0.3 rule 4), icon + word (rule 5), the same as the in-app run sheet
// (components/event/event-summary.tsx).
const h = vi.hoisted(() => ({ bundle: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async () => ({ data: h.bundle, error: null }),
  }),
}));

const SEISHIN_RED = "#a62a1c";

const song = (id: string, title: string, seconds: number) => ({
  id,
  kind: "song",
  title,
  duration_seconds: seconds,
  buffer_before_seconds: 0,
  buffer_after_seconds: 0,
  mic_slots: [],
  notes: null,
});

function bundle(hardOut: string) {
  return {
    event: {
      id: "e1",
      name: "A Lot Of Tone Fest",
      event_date: "2026-10-10",
      venue: null,
      event_type: "concert",
      show_start_time: "18:00:00",
      hard_out_time: hardOut,
      status: "approved",
      notes: null,
      map_url: null,
      costume_theme: null,
    },
    group: { id: "g1", name: "Seishin Kakumei", color: SEISHIN_RED, skin: SEISHIN_RED },
    schedule: [],
    // 2 × 4:00 from 18:00 → ends 18:08
    setlist: [song("a", "เพลง 1", 240), song("b", "เพลง 2", 240)],
    members: [],
  };
}

async function mount(hardOut: string) {
  h.bundle = bundle(hardOut);
  const ui = await SharePage({ params: Promise.resolve({ token: "tok" }) });
  return render(ui);
}

describe("Share page — past the hard out is the alarm, never the band's destructive", () => {
  it("the skin this page injects really does move --destructive off red (the premise)", () => {
    expect(skinCss(SEISHIN_RED)).toMatch(/--destructive:\s*265 /);
  });

  it("marks overtime with the alarm chip, icon + word", async () => {
    const { container } = await mount("18:05:00");
    const marker = screen.getByText(/เกิน Hard out/);
    const chip = marker.closest(".chip") as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.className.split(" ")).toContain("chip-alarm");
    expect(chip!.querySelector("svg")).not.toBeNull(); // icon + word
    // nothing on the sheet reaches for the band-skinned destructive token
    expect(container.querySelector('[class*="destructive"], .chip-danger')).toBeNull();
  });

  it("a set that fits says nothing about the hard out", async () => {
    await mount("18:30:00");
    expect(screen.queryByText(/เกิน Hard out/)).toBeNull();
  });
});
