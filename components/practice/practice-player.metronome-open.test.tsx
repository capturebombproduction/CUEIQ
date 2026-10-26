// 2026-10-27 bug hunt: the synced metronome opened while the song already plays anchored
// its count on the player's `position` - the last timeupdate, ~4 Hz, so up to 250 ms
// behind the song - and every click ran that much early for the rest of the song (the
// re-anchors mid-play read the running anchor, so they inherited it; only a pause or a
// seek put it right). Pinned: the player hands the metronome the engine's own playhead
// (getPosition) and a count started mid-song anchors on that.
// Harness: components/practice/practice-player.metronome-decode.test.tsx.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { PracticeSong, Song } from "@/lib/types";

type FakeEngine = {
  onTime: (t: number) => void;
  position: number;
  onPlayingChange: (p: boolean) => void;
  onPreparing: (p: boolean) => void;
  playing: boolean;
  tempos: number[];
};
const h = vi.hoisted(() => ({ engine: null as FakeEngine | null }));

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    playing = false;
    position = 0;
    songDuration = 200;
    canHandOff = false;
    handingOff = false;
    tempos: number[] = [];
    onTime: (t: number) => void = () => {};
    onDuration: (d: number) => void = () => {};
    onPlayingChange: (p: boolean) => void = () => {};
    onEnded: () => void = () => {};
    onPreparing: (p: boolean) => void = () => {};
    onStretchFailed: (e: unknown) => void = () => {};
    constructor() {
      h.engine = this as unknown as FakeEngine;
    }
    unlock() {}
    stopTails() {}
    handOff() {
      return false;
    }
    preload() {}
    clearPreload() {}
    async load() {}
    async play() {
      this.playing = true;
      this.onPlayingChange(true);
    }
    pause() {}
    toggle() {}
    seek() {}
    setTempo(t: number) {
      this.tempos.push(t);
    }
    setVolume() {}
    destroy() {}
    async getBuffer() {
      return {}; // decoded: the metronome's "ตรวจจับจังหวะจากเพลง" may analyse it
    }
  },
}));
// a 120 BPM song whose beats sit on every half second
const BEATS = Array.from({ length: 60 }, (_, i) => 8 + i * 0.5);
vi.mock("@/lib/bpm-detect", () => ({ detectBeats: () => ({ bpm: 120, beats: BEATS }) }));
vi.mock("@/lib/song-cache", () => ({ getSongBlob: (path: string) => Promise.resolve({ path }) }));
vi.mock("@/lib/local-source", () => ({
  getLocalSource: async () => null,
  listLocalSourceIds: async () => [],
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/components/practice/break-timer", () => ({ BreakTimer: () => null }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/count-samples", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/count-samples")>()),
  // no recorded voice: every beat is an oscillator click we can time
  loadCountSamples: () => new Promise<ArrayBuffer[]>(() => {}),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "order", "insert"]) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
      return b;
    },
  }),
}));

import { PracticePlayer } from "@/components/practice/practice-player";

const clicks: number[] = [];
let ctx: { currentTime: number } | null = null;

beforeEach(() => {
  clicks.length = 0;
  ctx = null;
  window.localStorage.clear();
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

const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 70)); // the scheduler runs every 25 ms
  });
const at = async (t: number) => {
  ctx!.currentTime = Math.round(t * 1000) / 1000;
  await tick();
};
const engine = () => h.engine!;
/** a time report, as the engine makes it: its playhead is there, and it says so */
const report = (t: number) => {
  engine().position = t;
  engine().onTime(t);
};

describe("PracticePlayer — the synced metronome opened mid-song", () => {
  it("anchors on where the song is, not on the last time report", async () => {
    const song = {
      id: "s1",
      tenant_id: "t1",
      group_id: "g1",
      title: "Neon Samurai",
      duration_seconds: 200,
      audio_path: "s1.wav",
      bpm: 120, // a beat on every half second of the song
    } as unknown as Song;
    render(
      <ConfirmProvider>
        <PracticePlayer
          eventId="room"
          groupId="g1"
          currentUserId="u1"
          songs={[song]}
          items={[{ id: "p1", song_id: "s1", sort_order: 1 } as PracticeSong]}
          setItems={() => {}}
          markers={{}}
          setMarkers={() => {}}
          canManage={false}
          canCurate={false}
        />
      </ConfirmProvider>
    );
    fireEvent.click(within(screen.getByRole("region", { name: "Queue" })).getByRole("button", { name: /Neon Samurai/ }));
    await waitFor(() => expect(engine().playing).toBe(true));
    // the last time report said 10.0; 200 ms on, the song is at 10.2 and the next report
    // has not come yet
    act(() => report(10));
    engine().position = 10.2;

    // the metronome is opened now (its clock reads 100.0)
    fireEvent.click(screen.getByRole("button", { name: /เมโทรนอม/ }));
    await tick();
    await at(100.1);
    await at(100.25);
    await at(100.4);

    // beat 10.0 sounded 200 ms ago in the song - never at 100.0 now; 10.5 is 0.3 s away
    expect(clicks).not.toContain(100);
    expect(clicks).toContain(100.3);
  });
});
