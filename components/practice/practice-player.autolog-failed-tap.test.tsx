// 2026-10-27 bug hunt (third pass): the practice auto-log after a tap whose song never
// loads. Song A plays; the member taps B and B's file can't be read (venue wifi, an
// expired link, offline and not cached). selectSong finalised A at the TAP, before the
// read: A's seconds so far were dropped (under 20 s) and its accounting cleared - and A,
// never replaced (the engine was never handed B), sounded on with nothing counting it:
// its end, the next pick, the page going away all found no song. A is now finalised only
// once the tap has the song to replace it with. Pinned:
//  - B's read fails: A plays on and is logged whole when it ends;
//  - B has no file at all (no master, no bytes on this device): the same;
//  - the room set's next song coming in over A's end ("เล่นซ้อน") fails to read: A
//    sounds out its end and is logged whole, and ▶ on it again is another run.
// Harness: components/practice/practice-player.autolog.test.tsx, with the room's set
// from components/practice/practice-player.room-set-edit.test.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { bkkTodayKey } from "@/lib/time";
import type { PracticeSong, Song } from "@/lib/types";

type FakeEngine = {
  loads: string[];
  onTime: (t: number) => void;
  onPlayingChange: (p: boolean) => void;
  onEnded: () => void;
  position: number;
  playing: boolean;
};
const h = vi.hoisted(() => ({
  engine: null as null | FakeEngine,
  inserts: [] as { table: string; values: Record<string, unknown> }[],
  shows: [] as unknown[],
  localIds: [] as string[],
  errors: [] as string[],
  infos: [] as string[],
}));

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    loads: string[] = [];
    playing = false;
    position = 0;
    songDuration = 200;
    get canHandOff() {
      return this.playing;
    }
    get handingOff() {
      return false;
    }
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
// song B's master cannot be read (venue wifi / an expired link / offline, not cached)
vi.mock("@/lib/song-cache", () => ({
  getSongBlob: (path: string) =>
    path === "b.wav" ? Promise.reject(new Error("Failed to fetch")) : Promise.resolve({ path }),
}));
vi.mock("@/lib/local-source", () => ({
  getLocalSource: async () => null,
  listLocalSourceIds: async () => h.localIds,
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/bpm-detect", () => ({ detectBeats: () => null }));
vi.mock("@/components/practice/metronome", () => ({ Metronome: () => null }));
vi.mock("@/components/practice/break-timer", () => ({ BreakTimer: () => null }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: (m: string) => h.errors.push(m),
    info: (m: string) => h.infos.push(m),
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
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "order"]) b[m] = () => b;
      b.insert = (values: Record<string, unknown>) => {
        h.inserts.push({ table, values });
        return b;
      };
      b.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve({ data: table === "events" ? h.shows : [], error: null }).then(ok, fail);
      return b;
    },
  }),
}));

import { PracticePlayer } from "@/components/practice/practice-player";

const songA = { id: "a", tenant_id: "t1", group_id: "g1", title: "Neon Samurai", duration_seconds: 200, audio_path: "a.wav" } as Song;
const songB = { id: "b", tenant_id: "t1", group_id: "g1", title: "Kaze no Uta", duration_seconds: 200, audio_path: "b.wav" } as Song;
// no master online, and (below) listed as held on this device - but its bytes are gone
const songC = { id: "c", tenant_id: "t1", group_id: "g1", title: "Yoru no Hikari", duration_seconds: 200, audio_path: null } as unknown as Song;
const runsOfA = () =>
  h.inserts
    .filter((i) => i.table === "practice_runs" && i.values.song_id === "a")
    .map((r) => Number(r.values.seconds));

let now = 1_000_000;
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => {
  h.inserts.length = 0;
  h.errors.length = 0;
  h.infos.length = 0;
  h.localIds = [];
  h.shows = [];
  window.localStorage.clear();
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.mocked(Date.now).mockRestore();
});

function mount(items: PracticeSong[]) {
  render(
    <ConfirmProvider>
      <PracticePlayer
        eventId="room"
        groupId="g1"
        currentUserId="u1"
        songs={[songA, songB, songC]}
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
const tap = (title: string) =>
  act(async () => {
    fireEvent.click(screen.getAllByText(title)[0].closest("button")!);
    await flush();
  });
// as the engine does at a song's end: not playing any more, then ended
const ends = () =>
  act(async () => {
    h.engine!.playing = false;
    h.engine!.onPlayingChange(false);
    h.engine!.onEnded();
    await flush();
  });

describe("practice auto-log — a tap whose song never loads", () => {
  it("B's read fails: A plays on, and is logged whole when it ends", async () => {
    mount([
      { id: "p-a", song_id: "a", sort_order: 1 } as PracticeSong,
      { id: "p-b", song_id: "b", sort_order: 2 } as PracticeSong,
    ]);
    await tap("Neon Samurai");
    now += 10_000; // 10 s of A
    await tap("Kaze no Uta"); // B: its read fails
    expect(h.errors).toContain("โหลดเพลงไม่สำเร็จ");
    expect(h.engine!.loads).toEqual(["a.wav"]); // the engine never got B
    expect(h.engine!.playing).toBe(true);

    now += 120_000; // A plays on for two more minutes, then ends
    await ends();
    expect(runsOfA()).toEqual([130]);
  });

  it("B has no file at all (no master, no bytes on this device): the same", async () => {
    h.localIds = ["c"];
    mount([
      { id: "p-a", song_id: "a", sort_order: 1 } as PracticeSong,
      { id: "p-c", song_id: "c", sort_order: 2 } as PracticeSong,
    ]);
    await screen.findAllByText("Yoru no Hikari");
    await tap("Neon Samurai");
    now += 10_000;
    await tap("Yoru no Hikari");
    expect(h.infos).toContain("ไฟล์เพิ่งอัปขึ้นคลังแล้ว");
    expect(h.engine!.loads).toEqual(["a.wav"]);

    now += 120_000;
    await ends();
    expect(runsOfA()).toEqual([130]);
  });

  it("the room set's next song fails to read as it comes in over A's end: A is logged whole, and played again is another run", async () => {
    // a show today, so the card opens on it - the room's own set is picked by hand
    h.shows = [
      {
        id: "show-1",
        name: "Thailand hobbyfestival",
        event_date: bkkTodayKey(),
        setlist_items: [{ id: "r1", title: "r1", kind: "song", song_id: "a", sort_order: 1 }],
      },
    ];
    // A, then B coming in 5 s before A ends
    mount([
      { id: "p-a", song_id: "a", sort_order: 1, buffer_before_seconds: 0 } as PracticeSong,
      { id: "p-b", song_id: "b", sort_order: 2, buffer_before_seconds: -5 } as PracticeSong,
    ]);
    await screen.findByRole("button", { name: /เล่นทั้งเซ็ต/ });
    fireEvent.change(screen.getByLabelText("เลือกงานที่จะซ้อม"), { target: { value: "room" } });
    const card = screen.getByRole("region", { name: "Setlist" });
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: /เล่นทั้งเซ็ต \(2 เพลง\)/ }));
      await flush();
    });
    expect(h.engine!.loads).toEqual(["a.wav"]);
    expect(h.engine!.playing).toBe(true);

    now += 30_000; // 30 s of A, and the playhead is where B comes in
    await act(async () => {
      h.engine!.position = 195.5;
      h.engine!.onTime(195.5);
      await new Promise((r) => setTimeout(r, 30)); // the overlap fires; B's read fails
    });
    expect(h.errors).toContain("โหลดเพลงไม่สำเร็จ");
    expect(h.engine!.loads).toEqual(["a.wav"]);
    expect(h.engine!.playing).toBe(true);

    now += 5_000; // A sounds out its end
    await ends();
    // ▶ on A again, a minute of it, and the page goes away
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "เล่น" }));
      await flush();
    });
    now += 60_000;
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await flush();
    });
    expect(runsOfA()).toEqual([35, 60]);
  });
});
