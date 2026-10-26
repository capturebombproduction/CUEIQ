// 2026-10-27 bug hunt: the screen wake lock while a practice song plays. The browser
// drops a wake lock whenever the page is hidden (a switch to LINE, the notification
// shade on Android), and the player asked for one only when `playing` CHANGED - back on
// the page with the song still playing nothing asked again, and the phone's screen
// slept mid-song (on iOS taking the Web Audio song and the metronome with it). Live Mode
// re-acquires on visibilitychange; the practice player now does too. Pinned here:
//  - back on the page with the song playing, the lock is asked for again - and that
//    lock is the one let go at ⏸;
//  - back on the page with the song paused, nothing is asked for;
//  - the player gone, a page coming back asks for nothing.
// Harness: components/practice/practice-player.autolog.test.tsx (its fake engine, with
// a ⏯ that really pauses).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { PracticeSong, Song } from "@/lib/types";

const h = vi.hoisted(() => ({
  engine: null as null | { onPlayingChange: (p: boolean) => void; playing: boolean },
}));

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    playing = false;
    position = 0;
    songDuration = 0;
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
    pause() {
      this.playing = false;
      this.onPlayingChange(false);
    }
    toggle() {
      this.playing = !this.playing;
      this.onPlayingChange(this.playing);
    }
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
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "order", "insert"]) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
      return b;
    },
  }),
}));

import { PracticePlayer } from "@/components/practice/practice-player";

const song = { id: "a", tenant_id: "t1", group_id: "g1", title: "Neon Samurai", duration_seconds: 228, audio_path: "a.wav" } as Song;
const items = [{ id: "p-a", song_id: "a", sort_order: 1 } as PracticeSong];

/** a WakeLockSentinel the test can have the browser let go of (fire) */
type Sentinel = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (t: string, f: () => void) => void;
  fire: () => void;
};
let held: Sentinel[] = [];
let visibility: DocumentVisibilityState = "visible";
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => {
  held = [];
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: {
      request: async () => {
        const listeners: (() => void)[] = [];
        const s: Sentinel = {
          released: false,
          release: async () => {
            s.released = true;
          },
          addEventListener: (_t, f) => listeners.push(f),
          fire: () => {
            s.released = true;
            listeners.forEach((f) => f());
          },
        };
        held.push(s);
        return s;
      },
    },
  });
});
afterEach(() => {
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
});

function mount() {
  return render(
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
}
const tapSong = () =>
  act(async () => {
    fireEvent.click(screen.getAllByText("Neon Samurai")[0].closest("button")!);
    await flush();
  });
/** the page is hidden - the browser lets go of the lock it holds - and comes back */
const awayAndBack = async () => {
  await act(async () => {
    visibility = "hidden";
    held.filter((s) => !s.released).forEach((s) => s.fire());
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
  });
  await act(async () => {
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
  });
};

describe("practice player — the screen wake lock", () => {
  it("back on the page with the song still playing, the lock is asked for again", async () => {
    mount();
    await tapSong();
    expect(h.engine!.playing).toBe(true);
    expect(held).toHaveLength(1);

    await awayAndBack(); // the member switched to LINE and back; the song never stopped
    expect(h.engine!.playing).toBe(true);
    expect(held).toHaveLength(2);
    expect(held[1].released).toBe(false);

    // …and that lock is the one let go at ⏸
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "หยุดชั่วคราว" }));
      await flush();
    });
    expect(h.engine!.playing).toBe(false);
    expect(held[1].released).toBe(true);
  });

  it("back on the page with the song paused, nothing is asked for", async () => {
    mount();
    await tapSong();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "หยุดชั่วคราว" }));
      await flush();
    });
    expect(held[0].released).toBe(true);

    await awayAndBack();
    expect(held).toHaveLength(1);
  });

  it("the player gone, a page coming back asks for nothing", async () => {
    const { unmount } = mount();
    await tapSong();
    const engine = h.engine!;
    unmount();
    engine.playing = true; // whatever the engine says, nothing is listening any more
    await awayAndBack();
    expect(held).toHaveLength(1);
  });
});
