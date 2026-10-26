// 2026-10-27 bug hunt (third pass): the song being played taken out of the room's own
// set while it runs. ✕ takes the row off the screen at once and the delete follows; the
// set-follow effect saw the row gone and ended the run AT ONCE - and when the delete then
// FAILED (venue wifi) removeSong put the row back, but nothing put the run back: the
// song played to its end and the set stopped there, although it never changed. The run
// is now left as it is while the delete is out, and ends when the delete lands. Pinned:
//  - a take-out that fails: the row is back and the set still plays on after the song;
//  - a take-out that lands: the run ends then, says so, and the song is not cut.
// The server answers after 100 ms, as venue wifi does - an instant answer is batched by
// React with the optimistic removal and never shows the set-follow effect the row gone.
// Harness: components/practice/practice-player.room-set-edit.test.tsx (its fake engine
// and supabase client, trimmed to what these need).
import { describe, it, expect, vi, beforeEach } from "vitest";
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
  pauses: number;
};
const h = vi.hoisted(() => ({
  engines: [] as FakeEngine[],
  shows: [] as unknown[],
  deletes: [] as { table: string; id: unknown }[],
  deleteFails: false,
  info: [] as string[],
}));

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    loads: string[] = [];
    duration = 200;
    position = 0;
    playing = false;
    pauses = 0;
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
      this.position = 0;
    }
    async play() {
      this.playing = true;
      this.onPlayingChange(true);
    }
    pause() {
      this.pauses++;
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
vi.mock("@/lib/local-source", () => ({
  getLocalSource: async () => null,
  listLocalSourceIds: async () => [],
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/bpm-detect", () => ({ detectBeats: () => null }));
vi.mock("@/components/practice/metronome", () => ({ Metronome: () => null }));
vi.mock("@/components/practice/break-timer", () => ({ BreakTimer: () => null }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: (m: string) => h.info.push(m) },
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: () => {
      const ch = {
        subscribe: (cb: (s: string) => void) => {
          cb("SUBSCRIBED");
          return ch;
        },
        send: () => Promise.resolve("ok"),
      };
      return ch;
    },
    removeChannel: () => Promise.resolve("ok"),
    from: (table: string) => {
      let deleting = false;
      const b = {
        select: () => b,
        eq: (col: string, v: unknown) => {
          if (deleting && col === "id") h.deletes.push({ table, id: v });
          return b;
        },
        gte: () => b,
        insert: () => b,
        update: () => b,
        delete: () => {
          deleting = true;
          return b;
        },
        then: (res: (v: unknown) => unknown) => {
          if (table === "events") return Promise.resolve({ data: h.shows, error: null }).then(res);
          // the answer takes a moment on venue wifi
          if (deleting)
            return new Promise((r) => setTimeout(r, 100))
              .then(() =>
                h.deleteFails
                  ? { data: null, error: { code: "08006", message: "Failed to fetch" } }
                  : { data: [{ id: "x" }], error: null }
              )
              .then(res);
          return Promise.resolve({ data: null, error: null }).then(res);
        },
      };
      return b;
    },
  }),
}));

import { PracticePlayer } from "@/components/practice/practice-player";

const song = (id: string, title: string): Song =>
  ({ id, tenant_id: "t1", group_id: "g1", title, duration_seconds: 200, audio_path: `${id}.wav` }) as Song;
const songs = [song("boot", "[SYSTEM_BOOT] SE"), song("iam", "I Am Who I Am"), song("neon", "Neon Lullaby")];

beforeEach(() => {
  h.engines = [];
  h.deletes = [];
  h.deleteFails = false;
  h.info = [];
  window.localStorage.clear();
  // a show today, so the card opens on it - the room's own set is picked by hand
  h.shows = [
    {
      id: "show-1",
      name: "Thailand hobbyfestival",
      event_date: bkkTodayKey(),
      setlist_items: [{ id: "r1", title: "r1", kind: "song", song_id: "boot", sort_order: 1 }],
    },
  ];
});

const engine = () => h.engines[h.engines.length - 1];
// as the engine does at a song's end: not playing any more, then ended
const end = () =>
  act(() => {
    const e = engine();
    e.playing = false;
    e.onPlayingChange(false);
    e.onEnded();
  });

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
const setCard = () => screen.getByRole("region", { name: "Setlist" });
const three = [
  { id: "p1", song_id: "iam", sort_order: 1, buffer_before_seconds: 0 },
  { id: "p2", song_id: "boot", sort_order: 2, buffer_before_seconds: 0 },
  { id: "p3", song_id: "neon", sort_order: 3, buffer_before_seconds: 0 },
] as PracticeSong[];

/** the room's set plays from iam; ✕ on iam, confirmed, the delete sent */
async function playSetAndTakeOutTheSongPlaying() {
  render(<Room start={three} />);
  await screen.findByRole("button", { name: /เล่นทั้งเซ็ต/ });
  fireEvent.change(screen.getByLabelText("เลือกงานที่จะซ้อม"), { target: { value: "room" } });
  fireEvent.click(within(setCard()).getByRole("button", { name: /เล่นทั้งเซ็ต \(3 เพลง\)/ }));
  await waitFor(() => expect(engine().loads).toEqual(["iam.wav"]));
  fireEvent.click(within(setCard()).getByRole("button", { name: /แก้เซ็ต/ }));
  fireEvent.click(screen.getByRole("button", { name: "เอาออกจากเซ็ต · I Am Who I Am" }));
  fireEvent.click(await screen.findByRole("button", { name: "เอาออก" }));
  await waitFor(() => expect(h.deletes).toHaveLength(1));
}

describe("PracticePlayer — the song being played taken out of the room's set", () => {
  it("a take-out that fails: the row is back and the set still plays on after the song", async () => {
    h.deleteFails = true;
    await playSetAndTakeOutTheSongPlaying();
    // the delete failed: the row is back in the set on screen
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "เอาออกจากเซ็ต · I Am Who I Am" })).toBeTruthy()
    );
    fireEvent.click(within(setCard()).getByRole("button", { name: /เสร็จ/ }));
    expect(h.info).not.toContain("หยุดเล่นต่อตามเซ็ตแล้ว");
    expect(within(setCard()).getByRole("button", { name: /หยุดเล่นต่อ/ })).toBeTruthy();

    end(); // iam ends: the set never changed, so it goes on to song 2
    await waitFor(() => expect(engine().loads).toEqual(["iam.wav", "boot.wav"]), { timeout: 1000 });
  });

  it("a take-out that lands: the run ends then, says so, and the song is not cut", async () => {
    await playSetAndTakeOutTheSongPlaying();
    await waitFor(() => expect(h.info).toContain("หยุดเล่นต่อตามเซ็ตแล้ว"));
    fireEvent.click(within(setCard()).getByRole("button", { name: /เสร็จ/ }));
    expect(within(setCard()).queryByRole("button", { name: /หยุดเล่นต่อ/ })).toBeNull();
    expect(within(setCard()).getByRole("button", { name: /เล่นทั้งเซ็ต \(2 เพลง\)/ })).toBeTruthy();
    expect(engine().playing).toBe(true);
    expect(engine().pauses).toBe(0);

    end(); // it plays on to its end, and nothing follows it
    await new Promise((r) => setTimeout(r, 50));
    expect(engine().loads).toEqual(["iam.wav"]);
  });
});
