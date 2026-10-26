// 2026-10-27 bug hunt: the first slow-down of a song mid-play (1× → 0.5×) makes the
// engine decode the whole file - seconds for a big WAV - with the song SILENT, while the
// engine keeps saying "playing" (a ⏸ in that window must still count as a pause, see
// practice-audio's doSwitch). The player handed that straight to the synced metronome:
// it re-anchored at the tap, counted on over the silence, and when the song came back
// at the point it was slowed at there was no jump in its position to re-anchor on - so
// the count stayed early by the whole decode until the next pause or seek.
// Pinned: while the engine prepares (the speed spinner) the metronome is told the song
// is not playing, and it anchors again at the real restart - for a count locked to the
// detected beats and for a free-running one at the song's saved BPM alike.
// Harness: the real Metronome (as in components/practice/metronome.reanchor.test.tsx)
// inside the real player, on a fake engine.
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

describe("PracticePlayer — the synced metronome across the first slow-down's decode", () => {
  it.each([
    ["locked to the detected beats", null],
    ["free-running at the song's saved BPM", 120],
  ])("%s: no count over the silent decode, on the beat when the song comes back", async (_, bpm) => {
    const song = {
      id: "s1",
      tenant_id: "t1",
      group_id: "g1",
      title: "Neon Samurai",
      duration_seconds: 200,
      audio_path: "s1.wav",
      bpm,
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
    // the song plays, and is at 10.0 s
    fireEvent.click(within(screen.getByRole("region", { name: "Queue" })).getByRole("button", { name: /Neon Samurai/ }));
    await waitFor(() => expect(engine().playing).toBe(true));
    act(() => report(10));

    // the metronome opened (ctx 100.0) follows it
    fireEvent.click(screen.getByRole("button", { name: /เมโทรนอม/ }));
    if (bpm == null) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /ตรวจจับจังหวะจากเพลง/ }));
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    await tick();
    expect(clicks).toContain(100); // beat 10.0 at ctx 100.0

    // ctx 100.2: the song reports 10.2, and the 0.5× key is tapped. The engine pauses
    // the element and decodes for 1.5 s - still "playing", but preparing (the spinner).
    ctx!.currentTime = 100.2;
    act(() => report(10.2));
    await tick();
    clicks.length = 0;
    fireEvent.click(within(screen.getByRole("group", { name: "ความเร็ว" })).getByRole("button", { name: "0.5×" }));
    expect(engine().tempos).toEqual([0.5]);
    act(() => engine().onPreparing(true));
    for (let t = 100.25; t < 101.7; t += 0.05) await at(t);
    const duringSilence = clicks.filter((t) => t > 100.25 && t < 101.7);

    // ctx 101.7: the decode lands; the stretch backend starts at 10.2 and plays
    ctx!.currentTime = 101.7;
    act(() => {
      engine().onPreparing(false);
      report(10.2);
      engine().onPlayingChange(true);
    });
    await tick();
    for (let t = 101.75; t < 102.45; t += 0.05) await at(t);

    // the song was silent from 100.2 to 101.7 - nothing is counted there
    expect(duringSilence).toEqual([]);
    // beat 10.5 is 0.3 song-s after 10.2 = 0.6 s at half speed: ctx 102.3
    expect(clicks).toContain(102.3);
  });
});
