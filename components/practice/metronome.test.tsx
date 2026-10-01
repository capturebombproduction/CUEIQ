// The metronome, Black Stage (spec §G.6): the closed key already says the tempo,
// and the open panel is a beat stage — one cell per beat of the bar — instead of
// a small dial. Only the presentation is under test; the scheduler never starts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { Song } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/count-samples", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/count-samples")>()),
  // never resolves: the count voice stays "loading", nothing decodes
  loadCountSamples: () => new Promise<ArrayBuffer[]>(() => {}),
}));

import { Metronome } from "./metronome";

const EMOJI = /\p{Extended_Pictographic}/u;

beforeEach(() => {
  class FakeCtx {
    state = "running";
    currentTime = 0;
    async resume() {}
    async close() {}
    async decodeAudioData() {
      return {};
    }
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeCtx;
});

const song = { id: "s1", title: "Seishin Kakumei", bpm: 174, audio_path: null } as unknown as Song;

describe("Metronome", () => {
  it("the closed key says the tempo", () => {
    render(<Metronome song={song} canManage={false} />);
    expect(screen.getByRole("button", { name: /เมโทรนอม\s*174/ })).toBeTruthy();
  });

  it("opens to a beat stage with one cell per beat of the bar, and no emoji in its chrome", () => {
    render(<Metronome song={song} canManage={false} />);
    fireEvent.click(screen.getByRole("button", { name: /เมโทรนอม/ }));
    const panel = screen.getByRole("region", { name: "Metronome" });
    const stage = within(panel).getByTestId("beat-stage");
    expect(stage.children).toHaveLength(8);
    expect(panel.textContent).not.toMatch(EMOJI);

    const beats = within(panel).getByRole("group", { name: "บีตต่อห้อง" });
    fireEvent.click(within(beats).getByRole("button", { name: "4" }));
    expect(within(beats).getByRole("button", { name: "4" }).getAttribute("aria-pressed")).toBe("true");
    expect(stage.children).toHaveLength(4);
  });
});
