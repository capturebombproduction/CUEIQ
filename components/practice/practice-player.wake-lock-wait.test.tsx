// The screen wake lock is held through a set's WAIT (2026-10-27 hunt 6): the room's set waits
// ("เข้าหลังเพลงก่อนหน้า" +N, up to 300 s) after a song ends, and the player used to let go of
// the lock the moment the song stopped - an iPhone (auto-lock 30 s) locked in the wait, iOS
// stopped the JS and the Web Audio with it, and the next song never came in.
// Harness as practice-player.room-set-wait-edit.test.tsx + practice-player.wake-lock.test.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { bkkTodayKey } from "@/lib/time";
import type { PracticeSong, Song } from "@/lib/types";

type FakeEngine = {
  loads: string[];
  onEnded: () => void;
  onPlayingChange: (p: boolean) => void;
  playing: boolean;
};
const h = vi.hoisted(() => ({ engines: [] as FakeEngine[], shows: [] as unknown[] }));

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    loads: string[] = [];
    duration = 200;
    position = 0;
    playing = false;
    get songDuration() {
      return this.duration;
    }
    get canHandOff() {
      return this.playing;
    }
    get handingOff() {
      return false;
    }
    clearPreload() {}
    onTime: (t: number) => void = () => {};
    onDuration: (d: number) => void = () => {};
    onPlayingChange: (p: boolean) => void = () => {};
    onEnded: () => void = () => {};
    onPreparing: (p: boolean) => void = () => {};
    onStretchFailed: (e: unknown) => void = () => {};
    constructor() {
      h.engines.push(this as unknown as FakeEngine);
    }
    unlock() {}
    stopTails() {}
    handOff() {
      return false;
    }
    preload() {}
    async load(b: { path: string }) {
      this.loads.push(b.path);
    }
    async play() {
      this.playing = true;
      this.onPlayingChange(true);
    }
    pause() {
      this.playing = false;
      this.onPlayingChange(false);
    }
    toggle() {}
    seek() {}
    setTempo() {}
    setVolume() {}
    destroy() {}
    async getBuffer() {
      return null;
    }
  },
}));
vi.mock("@/lib/song-cache", () => ({ getSongBlob: (path: string) => Promise.resolve({ path }) }));
vi.mock("@/lib/local-source", () => ({ getLocalSource: async () => null, listLocalSourceIds: async () => [] }));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/bpm-detect", () => ({ detectBeats: () => null }));
vi.mock("@/components/practice/metronome", () => ({ Metronome: () => null }));
vi.mock("@/components/practice/break-timer", () => ({ BreakTimer: () => null }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "order", "insert", "update", "delete"]) b[m] = () => b;
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(table === "events" ? { data: h.shows, error: null } : { data: null, error: null }).then(res);
      return b;
    },
  }),
}));

import { PracticePlayer } from "@/components/practice/practice-player";

const song = (id: string, title: string): Song =>
  ({ id, tenant_id: "t1", group_id: "g1", title, duration_seconds: 200, audio_path: `${id}.wav` }) as Song;
const songs = [song("boot", "[SYSTEM_BOOT] SE"), song("iam", "I Am Who I Am")];

type Sentinel = { released: boolean; release: () => Promise<void>; addEventListener: (t: string, f: () => void) => void };
let held: Sentinel[] = [];

beforeEach(() => {
  h.engines = [];
  held = [];
  window.localStorage.clear();
  h.shows = [
    {
      id: "show-1",
      name: "Thailand hobbyfestival",
      event_date: bkkTodayKey(),
      setlist_items: [{ id: "r1", title: "r1", kind: "song", song_id: "boot", sort_order: 1 }],
    },
  ];
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: {
      request: async () => {
        const s: Sentinel = {
          released: false,
          release: async () => {
            s.released = true;
          },
          addEventListener: () => {},
        };
        held.push(s);
        return s;
      },
    },
  });
});
afterEach(() => {
  delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
});

const engine = () => h.engines[h.engines.length - 1];

function Room({ start }: { start: PracticeSong[] }) {
  const [list, setList] = useState(start);
  return (
    <ConfirmProvider>
      <PracticePlayer
        eventId="room-1"
        groupId="g1"
        currentUserId="u1"
        songs={songs}
        items={list}
        setItems={setList}
        markers={{}}
        setMarkers={() => {}}
        canManage={false}
        canCurate
      />
    </ConfirmProvider>
  );
}

describe("practice player: the screen wake lock in a set's wait", () => {
  it("a 45 s wait after a song keeps the screen on until the next song", async () => {
    render(
      <Room
        start={
          [
            { id: "p1", song_id: "iam", sort_order: 1, buffer_before_seconds: 0 },
            { id: "p2", song_id: "boot", sort_order: 2, buffer_before_seconds: 45 }, // an MC break
          ] as PracticeSong[]
        }
      />
    );
    await screen.findByRole("button", { name: /เล่นทั้งเซ็ต/ });
    const card = screen.getByRole("region", { name: "Setlist" });
    fireEvent.change(screen.getByLabelText("เลือกงานที่จะซ้อม"), { target: { value: "room" } });
    fireEvent.click(within(card).getByRole("button", { name: /เล่นทั้งเซ็ต \(2 เพลง\)/ }));
    await waitFor(() => expect(engine().loads).toEqual(["iam.wav"]));
    await waitFor(() => expect(held).toHaveLength(1));
    expect(held[0].released).toBe(false);

    // iam ends: the set now waits 45 s, silent, for boot
    act(() => {
      const e = engine();
      e.playing = false;
      e.onPlayingChange(false);
      e.onEnded();
    });
    expect(screen.getByText(/รอ 45 วิ แล้วเริ่มเพลงถัดไป/)).toBeTruthy();

    // the set is still running (its wait is armed) - the screen must stay on
    const stillHeld = held.some((s) => !s.released);
    expect(stillHeld, "wake lock released at the song's end, mid-set, with a 45 s wait to go").toBe(true);
  });
});
