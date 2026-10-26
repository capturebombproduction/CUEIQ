// The practice auto-log (practice_runs - สมุดซ้อม's "ซ้อมวันนี้", the Training
// "ล่าสุด …" line and its Continue hero, the usage numbers the label reads) used to be
// written only when ANOTHER song was picked or the player unmounted. A closed tab /
// closed desktop window / a phone killing the backgrounded tab unmounts nothing - so
// the song a session ended on was never logged. And a refused insert still refreshed
// the journal as if it had been logged.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { PracticeSong, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  engine: null as null | {
    onPlayingChange: (p: boolean) => void;
    onEnded: () => void;
  },
  inserts: [] as { table: string; values: Record<string, unknown> }[],
  refuse: false,
}));

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    playing = false;
    onTime: (t: number) => void = () => {};
    onDuration: (d: number) => void = () => {};
    onPlayingChange: (p: boolean) => void = () => {};
    onEnded: () => void = () => {};
    onPreparing: (p: boolean) => void = () => {};
    onStretchFailed: (e: unknown) => void = () => {};
    constructor() {
      h.engine = this;
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
    setTempo() {}
    setVolume() {}
    destroy() {}
    async getBuffer() {
      return null;
    }
  },
}));
vi.mock("@/lib/song-cache", () => ({ getSongBlob: (path: string) => Promise.resolve({ path }) }));
vi.mock("@/lib/local-source", () => ({
  getLocalSource: async () => null,
  listLocalSourceIds: async () => [],
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/bpm-detect", () => ({ detectBeats: () => null }));
vi.mock("@/components/practice/metronome", () => ({ Metronome: () => null }));
vi.mock("@/components/practice/break-timer", () => ({ BreakTimer: () => null }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      let inserting = false;
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "order"]) b[m] = () => b;
      b.insert = (values: Record<string, unknown>) => {
        h.inserts.push({ table, values });
        inserting = true;
        return b;
      };
      b.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve(
          inserting && h.refuse
            ? { data: null, error: { code: "42501", message: "permission denied for table practice_runs" } }
            : { data: [], error: null }
        ).then(ok, fail);
      return b;
    },
  }),
}));

import { PracticePlayer } from "@/components/practice/practice-player";

const song = { id: "a", tenant_id: "t1", group_id: "g1", title: "Neon Samurai", duration_seconds: 228, audio_path: "a.wav" } as Song;
const items = [{ id: "p-a", song_id: "a", sort_order: 1 } as PracticeSong];
const runs = () => h.inserts.filter((i) => i.table === "practice_runs");

let now = 1_000_000;
async function startSong(onRunLogged?: () => void) {
  render(
    <ConfirmProvider>
      <PracticePlayer
        eventId="room"
        groupId="g1"
        currentUserId="u1"
        songs={[song]}
        items={items}
        setItems={() => {}}
        markers={{}}
        setMarkers={() => {}}
        canManage={false}
        canCurate
        onRunLogged={onRunLogged}
      />
    </ConfirmProvider>
  );
  await act(async () => {
    fireEvent.click(screen.getAllByText("Neon Samurai")[0].closest("button")!);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}
const ends = () =>
  act(async () => {
    h.engine!.onPlayingChange(false);
    h.engine!.onEnded();
    for (let i = 0; i < 3; i++) await Promise.resolve();
  });
const pageHides = () =>
  act(async () => {
    window.dispatchEvent(new Event("pagehide"));
    for (let i = 0; i < 3; i++) await Promise.resolve();
  });

beforeEach(() => {
  h.inserts.length = 0;
  h.refuse = false;
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.mocked(Date.now).mockRestore();
});

describe("practice auto-log", () => {
  it("logs a song played through, even when the session ends on it", async () => {
    await startSong();
    now += 228_000; // the whole song plays (3:48) and ends
    await ends();
    await pageHides(); // …and the band closes the laptop / the tab
    expect(runs()).toHaveLength(1);
    expect(runs()[0].values).toMatchObject({ song_id: "a", seconds: 228 });
  });

  it("logs the song still playing when the page goes away", async () => {
    await startSong();
    now += 60_000;
    await pageHides();
    expect(runs()).toHaveLength(1);
    expect(runs()[0].values).toMatchObject({ song_id: "a", seconds: 60 });
  });

  it("counts the same song played again after it ended as another run", async () => {
    await startSong();
    now += 228_000;
    await ends();
    // ▶ on the song that just ended
    await act(async () => {
      h.engine!.onPlayingChange(true);
    });
    now += 30_000;
    await pageHides();
    expect(runs().map((r) => r.values.seconds)).toEqual([228, 30]);
  });

  it("does not refresh the journal for an insert the server refused", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.refuse = true;
    const logged = vi.fn();
    await startSong(logged);
    now += 228_000;
    await ends();
    expect(runs()).toHaveLength(1);
    expect(logged).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("refreshes the journal once a run is logged", async () => {
    const logged = vi.fn();
    await startSong(logged);
    now += 228_000;
    await ends();
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
