// 2026-10-27 bug hunt: the room's own set ("เซ็ตของห้องนี้") edited WHILE it plays.
// The run kept the queue it copied at ▶, so the edit was never heard: with the set
// iam, boot, neon playing iam, a ↓ on boot made the card read iam, neon, boot - and when
// iam ended boot played, while the lit row (the card finds it by index in the set as it
// is now) sat on neon; a song taken out with ✕ still played. Pinned here:
//  - the set plays the order the card shows, from the song being played on;
//  - a song taken out is not played;
//  - the song being played taken out ends the run, and plays on to its end (not cut);
//  - a wait armed for the song that just ended survives that song being moved (the
//    run is found again by its row, not its index, so the wait still comes due).
// Harness: components/practice/practice-player.setlist.test.tsx (its fake engine and
// supabase client, trimmed to what these need; the client also answers a delete).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { bkkTodayKey } from "@/lib/time";
import type { PracticeSong, Song } from "@/lib/types";

type FakeEngine = {
  loads: string[];
  handOffs: string[];
  onEnded: () => void;
  onTime: (t: number) => void;
  onPlayingChange: (p: boolean) => void;
  position: number;
  playing: boolean;
  pauses: number;
};
const h = vi.hoisted(() => ({
  engines: [] as FakeEngine[],
  shows: [] as unknown[],
  updates: [] as { table: string; values: Record<string, unknown>; id: unknown }[],
  deletes: [] as { table: string; id: unknown }[],
}));

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    loads: string[] = [];
    handOffs: string[] = [];
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
      if (!this.playing) return false;
      this.handOffs.push(this.loads[this.loads.length - 1]);
      this.playing = false;
      this.onPlayingChange(false);
      return true;
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
vi.mock("@/lib/song-cache", () => ({
  getSongBlob: (path: string) => Promise.resolve({ path }),
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
const toastInfo = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: (m: string, o?: unknown) => toastInfo(m, o),
  },
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
const songs = [
  song("boot", "[SYSTEM_BOOT] SE"),
  song("neon", "Neon Lullaby"),
  song("iam", "I Am Who I Am"),
  song("other", "Transmission Failure"),
];

beforeEach(() => {
  h.engines = [];
  h.updates = [];
  h.deletes = [];
  toastInfo.mockClear();
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
const own = [
  { id: "p1", song_id: "iam", sort_order: 1, buffer_before_seconds: 0 },
  { id: "p2", song_id: "boot", sort_order: 2, buffer_before_seconds: 0 },
  { id: "p3", song_id: "neon", sort_order: 3, buffer_before_seconds: 0 },
] as PracticeSong[];
const setCard = () => screen.getByRole("region", { name: "Setlist" });
/** the row the card lights as playing */
const litRow = () =>
  within(setCard())
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-current") === "true")
    .map((b) => b.textContent);

async function playRoomSet(start = own) {
  render(<Room start={start} />);
  await screen.findByRole("button", { name: /เล่นทั้งเซ็ต/ });
  fireEvent.change(screen.getByLabelText("เลือกงานที่จะซ้อม"), { target: { value: "room" } });
  fireEvent.click(
    within(setCard()).getByRole("button", { name: new RegExp(`เล่นทั้งเซ็ต \\(${start.length} เพลง\\)`) })
  );
  await waitFor(() => expect(engine().loads).toEqual(["iam.wav"]));
}
const editSet = () => fireEvent.click(within(setCard()).getByRole("button", { name: /แก้เซ็ต/ }));
const doneEditing = () => fireEvent.click(within(setCard()).getByRole("button", { name: /เสร็จ/ }));
async function removeFromSet(title: string) {
  fireEvent.click(screen.getByRole("button", { name: `เอาออกจากเซ็ต · ${title}` }));
  fireEvent.click(await screen.findByRole("button", { name: "เอาออก" }));
  await waitFor(() => expect(h.deletes).toHaveLength(1));
}

describe("PracticePlayer — the room's own set edited while it plays", () => {
  it("after ↓ moves the next song down, the set plays the order it now shows", async () => {
    await playRoomSet();

    // while song 1 plays, the band swaps 2 and 3: the set now reads iam, neon, boot
    editSet();
    fireEvent.click(screen.getByRole("button", { name: "เลื่อนลง · [SYSTEM_BOOT] SE" }));
    await waitFor(() => expect(h.updates).toHaveLength(2));
    doneEditing();
    const rows = within(setCard()).getAllByRole("listitem").map((li) => li.textContent);
    expect(rows[1]).toContain("Neon Lullaby"); // the card says neon is next
    expect(litRow()).toEqual([expect.stringContaining("I Am Who I Am")]);

    end(); // song 1 ends
    await waitFor(() => expect(engine().loads).toHaveLength(2));
    // ...so neon is what plays next, and the row lit is the one sounding
    expect(engine().loads[1]).toBe("neon.wav");
    expect(litRow()).toEqual([expect.stringContaining("Neon Lullaby")]);
  });

  it("a song taken out of the set mid-run is not played", async () => {
    await playRoomSet();
    editSet();
    await removeFromSet("[SYSTEM_BOOT] SE");
    doneEditing();

    end();
    await waitFor(() => expect(engine().loads).toHaveLength(2));
    expect(engine().loads[1]).toBe("neon.wav");
  });

  it("the song being played taken out ends the run - it plays on to its end, nothing follows it", async () => {
    await playRoomSet();
    editSet();
    await removeFromSet("I Am Who I Am");

    // the set stopped following, and said so; the song was not cut
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("หยุดเล่นต่อตามเซ็ตแล้ว", expect.anything()));
    expect(within(setCard()).getByRole("button", { name: /เล่นทั้งเซ็ต \(2 เพลง\)/ })).toBeTruthy();
    expect(within(setCard()).queryByRole("button", { name: /หยุดเล่นต่อ/ })).toBeNull();
    expect(engine().playing).toBe(true);
    expect(engine().pauses).toBe(0);

    end();
    await new Promise((r) => setTimeout(r, 50));
    expect(engine().loads).toEqual(["iam.wav"]);
  });

  it("a wait armed for the song that ended still comes due after that song is moved", async () => {
    // iam, then boot after a 1 s wait, then other straight after
    await playRoomSet([
      { id: "p1", song_id: "iam", sort_order: 1, buffer_before_seconds: 0 },
      { id: "p2", song_id: "boot", sort_order: 2, buffer_before_seconds: 1 },
      { id: "p3", song_id: "other", sort_order: 3, buffer_before_seconds: 0 },
    ] as PracticeSong[]);
    end(); // iam ends: the set waits 1 s for boot
    expect(screen.getByText(/รอ 1 วิ แล้วเริ่มเพลงถัดไป/)).toBeTruthy();

    // in the wait, iam is moved below boot: the set reads boot, iam, other
    editSet();
    fireEvent.click(screen.getByRole("button", { name: "เลื่อนลง · I Am Who I Am" }));
    await waitFor(() => expect(h.updates).toHaveLength(2));
    doneEditing();

    // the wait still ends into what now follows iam - never a set left silent, still
    // claiming to play
    await waitFor(() => expect(engine().loads).toEqual(["iam.wav", "other.wav"]), { timeout: 2500 });
    expect(litRow()).toEqual([expect.stringContaining("Transmission Failure")]);
  });
});
