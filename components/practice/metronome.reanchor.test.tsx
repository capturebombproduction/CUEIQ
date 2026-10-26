// The beat-locked metronome maps song time to its audio clock through an anchor. A
// re-anchor in the middle of playback (÷2 / ×2 - the detect toast tells the band to
// press them while the song plays -, a detect landing, BPM −/+, a speed change) must
// anchor on where the song IS, not on the `position` prop: that is the player's last
// timeupdate (~4 Hz, up to 250 ms behind), and anchoring on it shifted every later
// click late by that much and played the beat that had just sounded a second time.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { Song } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/count-samples", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/count-samples")>()),
  // no recorded voice: every beat is an oscillator click we can time
  loadCountSamples: () => new Promise<ArrayBuffer[]>(() => {}),
}));

import { Metronome } from "@/components/practice/metronome";

const clicks: number[] = [];
let ctx: { currentTime: number } | null = null;

beforeEach(() => {
  clicks.length = 0;
  const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  class FakeCtx {
    state = "running";
    currentTime = 100;
    destination = {};
    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      ctx = this;
    }
    async resume() {}
    async close() {}
    async decodeAudioData() {
      return {};
    }
    createGain() {
      return { gain: param(), connect() {} };
    }
    createOscillator() {
      return {
        frequency: { value: 0 },
        connect() {},
        start: (t: number) => clicks.push(Math.round(t * 1000) / 1000),
        stop() {},
        addEventListener() {},
      };
    }
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeCtx;
});

// a 120 BPM song whose beats sit on every half second
const BEATS = Array.from({ length: 60 }, (_, i) => 8 + i * 0.5);
const song = { id: "s1", title: "Neon Samurai", bpm: null, audio_path: "s1.wav" } as unknown as Song;

const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 70)); // the scheduler runs every 25 ms
  });

const el = (speed: number) => (
  <Metronome
    song={song}
    canManage={false}
    playing
    position={10} // the last timeupdate: the song was at 10.0 s at ctx 100.0
    speed={speed}
    onDetectBeats={async () => ({ bpm: 120, beats: BEATS })}
  />
);

/** open the panel while the song plays (it syncs) and lock to the detected beats */
async function lockedAt100(speed = 1) {
  const view = render(el(speed));
  fireEvent.click(screen.getByRole("button", { name: /เมโทรนอม/ }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /ตรวจจับจังหวะจากเพลง/ }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await tick();
  expect(clicks).toContain(100); // beat 10.0 on its moment
  return view;
}

describe("beat-locked metronome, re-anchored while the song plays", () => {
  it("÷2 keeps the clicks on the song's beats", async () => {
    await lockedAt100();
    // 200 ms on: the song is at 10.2, but the next timeupdate has not come yet
    ctx!.currentTime = 100.2;
    await tick();
    clicks.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "÷2" })); // working beats 8, 9, 10, 11, …
    await tick();
    // beat 10 already sounded at 100.0 - it must not be played again now
    expect(clicks).not.toContain(100.2);

    ctx!.currentTime = 100.95;
    await tick();
    // beat 11.0 of the song is at ctx 101.0 - the clock never moved
    expect(clicks).toContain(101);
  });

  it("a speed change re-anchors from where the song is, at the new speed", async () => {
    const view = await lockedAt100();
    ctx!.currentTime = 100.2; // song at 10.2, prop still says 10.0
    await tick();
    clicks.length = 0;
    view.rerender(el(0.5)); // slowed to 0.5×
    await tick();
    expect(clicks).not.toContain(100.2); // beat 10 again
    ctx!.currentTime = 100.75;
    await tick();
    // beat 10.5 is 0.3 song-seconds away = 0.6 s at half speed
    expect(clicks).toContain(100.8);
  });
});
