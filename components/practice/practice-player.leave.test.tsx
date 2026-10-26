// A song tapped in the practice room and still downloading when the player goes away
// (any navigation out of the room) must never start after the player is gone: no
// control on any screen could stop it then. Uses the REAL PracticeAudioEngine.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { PracticeAudioEngine } from "@/lib/practice-audio";
import type { PracticeSong, Song } from "@/lib/types";

const dl = vi.hoisted(() => ({ resolve: null as null | ((b: Blob) => void) }));

vi.mock("@/lib/song-cache", () => ({
  getSongBlob: () =>
    new Promise<Blob>((r) => {
      dl.resolve = r; // a big master on venue wifi: lands whenever the test says
    }),
}));
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
      const b = {
        select: () => b,
        eq: () => b,
        in: () => b,
        gte: () => b,
        insert: () => b,
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
      };
      return b;
    },
  }),
}));

// jsdom has no Web Audio; unlock() builds a context inside the tap
class FakeAudioContext {
  state = "running";
  destination = {};
  resume = () => Promise.resolve();
  close = () => Promise.resolve();
  createGain() {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }
  createBuffer() {
    return {};
  }
  createBufferSource() {
    return { buffer: null, connect: () => {}, start: () => {} };
  }
}
(window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;

import { PracticePlayer } from "@/components/practice/practice-player";

const song = { id: "a", tenant_id: "t1", group_id: "g1", title: "Neon Samurai", duration_seconds: 228, audio_path: "a.wav" } as Song;
const items = [{ id: "p-a", song_id: "a", sort_order: 1 } as PracticeSong];

const mount = () =>
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
      />
    </ConfirmProvider>
  );

/** tap the song in the Queue (its download starts), leave, then let it land */
async function tapLeaveLand(view: ReturnType<typeof mount>) {
  fireEvent.click(screen.getAllByText("Neon Samurai")[0].closest("button")!);
  await act(async () => {
    await Promise.resolve();
  });
  expect(dl.resolve).not.toBeNull();
  view.unmount();
  await act(async () => {
    dl.resolve!(new Blob(["RIFF"], { type: "audio/wav" }));
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  dl.resolve = null;
});

describe("leaving the practice player while a tapped song is still downloading", () => {
  it("never starts that song after the player is gone", async () => {
    const played: string[] = [];
    (HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      function (this: HTMLMediaElement) {
        played.push(this.src);
        return Promise.resolve();
      }
    );
    const view = mount();
    await tapLeaveLand(view);
    // nothing may start playing a real song now - there is no ⏸ left to stop it
    expect(played.filter((src) => src.startsWith("blob:"))).toEqual([]);
  });

  it("does not hand the late download to the engine it destroyed at all", async () => {
    const load = vi.spyOn(PracticeAudioEngine.prototype, "load");
    const play = vi.spyOn(PracticeAudioEngine.prototype, "play");
    try {
      const view = mount();
      await tapLeaveLand(view);
      // the player's own guard - the engine refusing it is the second line
      expect(load).not.toHaveBeenCalled();
      expect(play).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
      play.mockRestore();
    }
  });
});
