// 2026-10-27 bug hunt (third pass): the room's own set edited during a WAIT ("เข้าหลังเพลง
// ก่อนหน้า" +N) so that nothing follows the song that just ended any more - the next
// song taken out, or the song that ended moved to the bottom. The run is rebuilt and
// found again by its row; when the wait came due there was no song after it, and the
// wait just returned: the card stayed on "กำลังเล่นเพลงที่ N/N" with its หยุดเล่นต่อ key,
// silent for good. It now ends as a set's last song does - "ซ้อมครบทั้งเซ็ตแล้ว".
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
};
const h = vi.hoisted(() => ({
  engines: [] as FakeEngine[],
  shows: [] as unknown[],
  updates: [] as { table: string; values: Record<string, unknown>; id: unknown }[],
  deletes: [] as { table: string; id: unknown }[],
  success: [] as string[],
}));

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
      this.position = 0;
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
  toast: { success: (m: string) => h.success.push(m), error: vi.fn(), info: vi.fn() },
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
      let update: Record<string, unknown> | null = null;
      let deleting = false;
      const b = {
        select: () => b,
        eq: (col: string, v: unknown) => {
          if (update && col === "id") h.updates.push({ table, values: update, id: v });
          if (deleting && col === "id") h.deletes.push({ table, id: v });
          return b;
        },
        gte: () => b,
        insert: () => b,
        update: (v: Record<string, unknown>) => {
          update = v;
          return b;
        },
        delete: () => {
          deleting = true;
          return b;
        },
        then: (res: (v: unknown) => unknown) => {
          if (table === "events") return Promise.resolve({ data: h.shows, error: null }).then(res);
          if (update || deleting) return Promise.resolve({ data: [{ id: "x" }], error: null }).then(res);
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
const songs = [song("boot", "[SYSTEM_BOOT] SE"), song("iam", "I Am Who I Am")];

beforeEach(() => {
  h.engines = [];
  h.updates = [];
  h.deletes = [];
  h.success = [];
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
// iam, then boot after a 1 s wait
const twoWithWait = [
  { id: "p1", song_id: "iam", sort_order: 1, buffer_before_seconds: 0 },
  { id: "p2", song_id: "boot", sort_order: 2, buffer_before_seconds: 1 },
] as PracticeSong[];

async function playRoomSetIntoItsWait() {
  render(<Room start={twoWithWait} />);
  await screen.findByRole("button", { name: /เล่นทั้งเซ็ต/ });
  fireEvent.change(screen.getByLabelText("เลือกงานที่จะซ้อม"), { target: { value: "room" } });
  fireEvent.click(within(setCard()).getByRole("button", { name: /เล่นทั้งเซ็ต \(2 เพลง\)/ }));
  await waitFor(() => expect(engine().loads).toEqual(["iam.wav"]));
  end(); // iam ends: the set waits 1 s for boot
  expect(screen.getByText(/รอ 1 วิ แล้วเริ่มเพลงถัดไป/)).toBeTruthy();
}
const editSet = () => fireEvent.click(within(setCard()).getByRole("button", { name: /แก้เซ็ต/ }));
const doneEditing = () => fireEvent.click(within(setCard()).getByRole("button", { name: /เสร็จ/ }));

describe("PracticePlayer — a wait whose next song is edited away", () => {
  it("the next song taken out in the wait: when it comes due the set ends, not left 'playing' in silence", async () => {
    await playRoomSetIntoItsWait();
    editSet();
    fireEvent.click(screen.getByRole("button", { name: "เอาออกจากเซ็ต · [SYSTEM_BOOT] SE" }));
    fireEvent.click(await screen.findByRole("button", { name: "เอาออก" }));
    await waitFor(() => expect(h.deletes).toHaveLength(1));
    doneEditing();

    // the wait comes due: nothing follows iam now, so the set is done - and says so
    await waitFor(() => expect(h.success).toContain("ซ้อมครบทั้งเซ็ตแล้ว"), { timeout: 2500 });
    expect(within(setCard()).queryByRole("button", { name: /หยุดเล่นต่อ/ })).toBeNull();
    expect(within(setCard()).getByRole("button", { name: /เล่นทั้งเซ็ต \(1 เพลง\)/ })).toBeTruthy();
    expect(engine().loads).toEqual(["iam.wav"]); // nothing was played after it
  });

  it("the song that ended moved to the bottom in the wait: the set ends the same way", async () => {
    await playRoomSetIntoItsWait();
    editSet();
    fireEvent.click(screen.getByRole("button", { name: "เลื่อนลง · I Am Who I Am" }));
    await waitFor(() => expect(h.updates).toHaveLength(2));
    doneEditing();

    await waitFor(() => expect(h.success).toContain("ซ้อมครบทั้งเซ็ตแล้ว"), { timeout: 2500 });
    expect(within(setCard()).queryByRole("button", { name: /หยุดเล่นต่อ/ })).toBeNull();
    expect(within(setCard()).getByRole("button", { name: /เล่นทั้งเซ็ต \(2 เพลง\)/ })).toBeTruthy();
    expect(engine().loads).toEqual(["iam.wav"]);
  });
});
