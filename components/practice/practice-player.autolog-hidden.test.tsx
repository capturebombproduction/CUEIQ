// 2026-10-27 bug hunt: the practice auto-log's last chance was pagehide, and it almost
// never reached the server - its insert starts only after supabase-js has read the
// session, and a closing tab / closed desktop window cancels it by then; iOS killing a
// backgrounded tab fires no pagehide at all, only visibilitychange → hidden. Pinned:
// a page going out of sight logs what has played so far, and a song still playing counts
// on from that moment - what it plays after (in the background, or once shown again) is
// logged by its end, the next song or the page going away, once and never on top of
// what was logged at hidden. Seconds too few to log are kept, not lost.
// Harness: components/practice/practice-player.autolog.test.tsx.
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
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "order"]) b[m] = () => b;
      b.insert = (values: Record<string, unknown>) => {
        h.inserts.push({ table, values });
        return b;
      };
      b.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(ok, fail);
      return b;
    },
  }),
}));

import { PracticePlayer } from "@/components/practice/practice-player";

const song = { id: "a", tenant_id: "t1", group_id: "g1", title: "Neon Samurai", duration_seconds: 228, audio_path: "a.wav" } as Song;
const items = [{ id: "p-a", song_id: "a", sort_order: 1 } as PracticeSong];
const runs = () => h.inserts.filter((i) => i.table === "practice_runs").map((r) => r.values.seconds);

let now = 1_000_000;
let visibility: DocumentVisibilityState = "visible";
async function startSong() {
  const view = render(
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
      />
    </ConfirmProvider>
  );
  await act(async () => {
    fireEvent.click(screen.getAllByText("Neon Samurai")[0].closest("button")!);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
  return view;
}
const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};
const goes = (state: DocumentVisibilityState) =>
  act(async () => {
    visibility = state;
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
  });
const ends = () =>
  act(async () => {
    h.engine!.onPlayingChange(false);
    h.engine!.onEnded();
    await flush();
  });
const pageHides = () =>
  act(async () => {
    window.dispatchEvent(new Event("pagehide"));
    await flush();
  });

beforeEach(() => {
  h.inserts.length = 0;
  now = 1_000_000;
  visibility = "visible";
  vi.spyOn(Date, "now").mockImplementation(() => now);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  vi.mocked(Date.now).mockRestore();
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
});

describe("practice auto-log — the page going out of sight", () => {
  it("logs the song playing when the page is hidden (iOS may kill it there with no pagehide)", async () => {
    await startSong();
    now += 60_000;
    await goes("hidden");
    expect(runs()).toEqual([60]);
  });

  it("the song plays on in the background: its end logs only what it played after", async () => {
    await startSong();
    now += 60_000;
    await goes("hidden");
    now += 168_000; // the phone is locked, the song plays to its end
    await ends();
    expect(runs()).toEqual([60, 168]);
    await pageHides(); // …and then the tab goes
    expect(runs()).toEqual([60, 168]);
  });

  it("hidden, then the tab closes or the player leaves: nothing is counted twice", async () => {
    const view = await startSong();
    now += 60_000;
    await goes("hidden");
    expect(runs()).toEqual([60]);
    await pageHides();
    view.unmount();
    expect(runs()).toEqual([60]);
  });

  it("hidden, shown again, then the song ends: before and after are each counted once", async () => {
    await startSong();
    now += 60_000;
    await goes("hidden");
    now += 5_000;
    await goes("visible");
    now += 25_000;
    await ends();
    expect(runs()).toEqual([60, 30]);
  });

  it("seconds too few to log at hidden are kept, not lost", async () => {
    await startSong();
    now += 10_000;
    await goes("hidden");
    expect(runs()).toEqual([]);
    await goes("visible");
    now += 15_000;
    await goes("hidden"); // the 10 s kept + 15 s since
    expect(runs()).toEqual([25]);
    now += 5_000;
    await ends();
    expect(runs()).toEqual([25]); // 5 s more: kept for the song's next run, not logged
  });

  it("a paused song is logged at hidden, and nothing counts while it stays paused", async () => {
    await startSong();
    now += 40_000;
    await act(async () => h.engine!.onPlayingChange(false)); // ⏸
    now += 600_000; // ten minutes on the pause
    await goes("hidden");
    expect(runs()).toEqual([40]);
    now += 600_000;
    await pageHides();
    expect(runs()).toEqual([40]);
  });
});
