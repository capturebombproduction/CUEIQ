// An Ar sets a song's tempo in the metronome and presses "บันทึกลงเพลง": the library
// now has it (songs.bpm), and so must this room. It holds the page-load `songs`
// snapshot, and the metronome's song-change effect puts song.bpm back on every visit -
// so going to the next song and back used to bring the OLD tempo back, and the synced
// count ran at it until the page was reloaded.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { PracticeSong, Song } from "@/lib/types";

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    playing = false;
    onTime: (t: number) => void = () => {};
    onDuration: (d: number) => void = () => {};
    onPlayingChange: (p: boolean) => void = () => {};
    onEnded: () => void = () => {};
    onPreparing: (p: boolean) => void = () => {};
    onStretchFailed: (e: unknown) => void = () => {};
    unlock() {}
    stopTails() {}
    handOff() {
      return false;
    }
    preload() {}
    clearPreload() {}
    async load() {}
    async play() {} // stays paused: the metronome's scheduler never needs to run here
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
vi.mock("@/components/practice/break-timer", () => ({ BreakTimer: () => null }));
vi.mock("@/lib/count-samples", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/count-samples")>()),
  loadCountSamples: () => new Promise<ArrayBuffer[]>(() => {}),
}));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
const saved = vi.hoisted(() => [] as unknown[]);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      let update: unknown = null;
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "order", "insert"]) b[m] = () => b;
      b.update = (v: unknown) => {
        update = v;
        return b;
      };
      b.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
        if (table === "songs" && update) {
          saved.push(update);
          return Promise.resolve({ data: [{ id: "a" }], error: null }).then(ok, fail);
        }
        return Promise.resolve({ data: [], error: null }).then(ok, fail);
      };
      return b;
    },
  }),
}));

class FakeCtx {
  state = "running";
  currentTime = 0;
  destination = {};
  async resume() {}
  async close() {}
  async decodeAudioData() {
    return {};
  }
}
(window as unknown as { AudioContext: unknown }).AudioContext = FakeCtx;

import { PracticePlayer } from "@/components/practice/practice-player";

const A = { id: "a", tenant_id: "t1", group_id: "g1", title: "Neon Samurai", duration_seconds: 228, audio_path: "a.wav", bpm: 100 } as Song;
const B = { id: "b", tenant_id: "t1", group_id: "g1", title: "Kakumei", duration_seconds: 200, audio_path: "b.wav", bpm: 140 } as Song;
const items = [A, B].map((s, i) => ({ id: `p-${s.id}`, song_id: s.id, sort_order: i + 1 }) as PracticeSong);

const pick = async (title: string) => {
  const queue = screen.getByRole("region", { name: "Queue" });
  await act(async () => {
    fireEvent.click(within(queue).getByText(title).closest("button")!);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

describe("metronome tempo saved to the song", () => {
  it("is still the song's tempo after visiting another song", async () => {
    render(
      <ConfirmProvider>
        <PracticePlayer
          eventId="room"
          groupId="g1"
          currentUserId="u1"
          songs={[A, B]}
          items={items}
          setItems={() => {}}
          markers={{}}
          setMarkers={() => {}}
          canManage
          canCurate
        />
      </ConfirmProvider>
    );
    await pick("Neon Samurai");
    fireEvent.click(screen.getByRole("button", { name: /เมโทรนอม/ }));
    const panel = screen.getByRole("region", { name: "Metronome" });
    for (let i = 0; i < 3; i++) fireEvent.click(within(panel).getByRole("button", { name: "เพิ่ม BPM" }));
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: /บันทึกลงเพลง/ }));
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(saved).toEqual([{ bpm: 103 }]); // the library now says 103

    await pick("Kakumei");
    expect(within(panel).getByText("140")).toBeTruthy();
    await pick("Neon Samurai");
    // back on the song whose tempo was just saved
    expect(within(screen.getByRole("region", { name: "Metronome" })).queryByText("103")).not.toBeNull();
  });
});
