// The practice room's Now Playing hero (spec §G.6). Presentation, but each control
// in it reaches the engine through the player's own functions — so what is pinned
// is that they reach it: ⏭ loads the next listed song, ±5 s seeks from the
// playhead, a section chip jumps, the speed segment sets the tempo, and the hero
// says which song this is and where it sits.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { PracticeSong, Song, SongMarker } from "@/lib/types";

type FakeEngine = {
  loads: string[];
  seeks: number[];
  tempos: number[];
  plays: number;
  onTime: (t: number) => void;
  onDuration: (d: number) => void;
};
const h = vi.hoisted(() => ({
  engines: [] as FakeEngine[],
  // the songs table as the cover read sees it (filtered by its .eq("id", …))
  coverRows: [] as { id: string; cover: string | null }[],
  coverReads: [] as string[],
}));

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    loads: string[] = [];
    seeks: number[] = [];
    tempos: number[] = [];
    plays = 0;
    playing = false;
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
    async load(b: { path: string }) {
      this.loads.push(b.path);
    }
    async play() {
      this.plays++;
      this.playing = true;
      this.onPlayingChange(true);
    }
    pause() {}
    toggle() {}
    seek(t: number) {
      this.seeks.push(t);
    }
    setTempo(t: number) {
      this.tempos.push(t);
    }
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
      // no shows → the setlist card stays out of the way; songs answers the cover read
      let id: unknown = null;
      const b = {
        select: () => b,
        eq: (col: string, v: unknown) => {
          if (col === "id") id = v;
          return b;
        },
        gte: () => b,
        insert: () => b,
        then: (res: (v: unknown) => unknown) => {
          if (table === "songs") h.coverReads.push(String(id));
          const data = table === "songs" ? h.coverRows.filter((r) => r.id === id) : [];
          return Promise.resolve({ data, error: null }).then(res);
        },
      };
      return b;
    },
  }),
}));

import { PracticePlayer } from "./practice-player";

const song = (id: string, title: string): Song =>
  ({ id, tenant_id: "t1", group_id: "g1", title, duration_seconds: 228, audio_path: `${id}.wav` }) as Song;
const songs = [song("a", "Seishin Kakumei"), song("b", "Neon Samurai"), song("c", "Akai Hana")];
const items = songs.map((s, i) => ({ id: `p-${s.id}`, song_id: s.id, sort_order: i }) as PracticeSong);
const marks = (songId: string): SongMarker[] =>
  [
    ["m1", "Intro", 0],
    ["m2", "Hook", 71],
    ["m3", "Bridge", 150],
  ].map(([id, label, pos]) => ({ id, song_id: songId, label, position_seconds: pos }) as SongMarker);

const mount = (markers: Record<string, SongMarker[]> = {}, canCurate = false) =>
  render(
    <ConfirmProvider>
      <PracticePlayer
        roomName="ห้องซ้อม — RED REVOLUTION"
        eventId="room"
        groupId="g1"
        currentUserId="u1"
        songs={songs}
        items={items}
        setItems={() => {}}
        markers={markers}
        setMarkers={() => {}}
        canManage={false}
        canCurate={canCurate}
      />
    </ConfirmProvider>
  );
const engine = () => h.engines[h.engines.length - 1];
const hero = () => screen.getByRole("region", { name: "Now playing" });

async function pick(title: string, path: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(title) }));
  await waitFor(() => expect(engine().loads).toContain(path));
}

beforeEach(() => {
  h.engines = [];
  h.coverRows = [];
  h.coverReads = [];
});

describe("PracticePlayer — the Now Playing hero", () => {
  it("names the song and where it sits in the queue, under the room's name", async () => {
    mount();
    expect(hero().textContent).toContain("ยังไม่ได้เลือกเพลง");
    await pick("Neon Samurai", "b.wav");
    expect(within(hero()).getByText("Neon Samurai")).toBeTruthy();
    expect(hero().textContent).toMatch(/ห้องซ้อม — RED REVOLUTION · 2 \/ 3/);
  });

  it("wears the song's own cover when it has one, else the band tile", async () => {
    const COVER = "data:image/webp;base64,UklGRg==";
    songs[1].cover = COVER;
    try {
      mount();
      await pick("Seishin Kakumei", "a.wav");
      expect(hero().querySelector("img")).toBeNull();
      await pick("Neon Samurai", "b.wav");
      await waitFor(() => expect(hero().querySelector("img")?.getAttribute("src")).toBe(COVER));
    } finally {
      delete songs[1].cover;
    }
  });

  it("reads the cover the room was not handed (the event bundle leaves covers out), once per song", async () => {
    const COVER = "data:image/webp;base64,UklGRg==";
    h.coverRows = [{ id: "c", cover: COVER }];
    mount();
    await pick("Neon Samurai", "b.wav");
    await waitFor(() => expect(h.coverReads).toEqual(["b"]));
    expect(hero().querySelector("img")).toBeNull();
    await pick("Akai Hana", "c.wav");
    await waitFor(() => expect(hero().querySelector("img")?.getAttribute("src")).toBe(COVER));
    // back to a song already asked about: no second read
    fireEvent.click(within(hero()).getByRole("button", { name: /เพลงก่อนหน้า/ }));
    await waitFor(() => expect(engine().loads).toEqual(["b.wav", "c.wav", "b.wav"]));
    await waitFor(() => expect(hero().querySelector("img")).toBeNull());
    expect(h.coverReads).toEqual(["b", "c"]);
  });

  it("⏭ loads the next song on the list, and is off on the last one", async () => {
    mount();
    await pick("Neon Samurai", "b.wav");
    fireEvent.click(within(hero()).getByRole("button", { name: "เพลงถัดไป" }));
    await waitFor(() => expect(engine().loads).toEqual(["b.wav", "c.wav"]));
    await waitFor(() => expect(within(hero()).getByText("Akai Hana")).toBeTruthy());
    expect(within(hero()).getByRole("button", { name: "เพลงถัดไป" })).toHaveProperty("disabled", true);
  });

  it("⏮ near the top of a song goes to the song before it; further in, back to 0:00", async () => {
    mount();
    await pick("Neon Samurai", "b.wav");
    act(() => engine().onTime(40));
    fireEvent.click(within(hero()).getByRole("button", { name: /เพลงก่อนหน้า/ }));
    expect(engine().seeks.at(-1)).toBe(0);
    act(() => engine().onTime(1));
    fireEvent.click(within(hero()).getByRole("button", { name: /เพลงก่อนหน้า/ }));
    await waitFor(() => expect(engine().loads).toEqual(["b.wav", "a.wav"]));
  });

  it("−5 s / +5 s seek from the playhead", async () => {
    mount();
    await pick("Seishin Kakumei", "a.wav");
    act(() => engine().onTime(30));
    fireEvent.click(within(hero()).getByRole("button", { name: "ย้อน 5 วินาที" }));
    expect(engine().seeks.at(-1)).toBe(25);
    fireEvent.click(within(hero()).getByRole("button", { name: "ข้ามไป 5 วินาที" }));
    expect(engine().seeks.at(-1)).toBe(35);
  });

  it("section chips jump, and the one the playhead is in is pressed", async () => {
    mount({ a: marks("a") });
    await pick("Seishin Kakumei", "a.wav");
    act(() => engine().onTime(80));
    const chips = within(within(hero()).getByRole("group", { name: "ท่อนเพลง" })).getAllByRole("button");
    expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    fireEvent.click(chips[2]);
    expect(engine().seeks.at(-1)).toBe(150);
  });

  it("in edit mode each chip's delete key is its own 44 × 44 target, set apart from the jump chip", async () => {
    // the delete is instant and the marks are the song's (every room sees them),
    // so a thumb aimed at the jump chip must not land on it
    mount({ a: marks("a") }, true);
    await pick("Seishin Kakumei", "a.wav");
    fireEvent.click(screen.getByRole("button", { name: /แก้ไข/ }));
    const del = within(hero()).getByRole("button", { name: "ลบท่อน Hook" });
    expect(del.className).toMatch(/\bh-11\b/);
    expect(del.className).toMatch(/\bw-11\b/);
    expect((del.parentElement as HTMLElement).className).toMatch(/\bgap-/);
  });

  it("speed is one segmented control: the pressed speed is marked and reaches the engine", async () => {
    mount();
    await pick("Seishin Kakumei", "a.wav");
    const seg = within(hero()).getByRole("group", { name: "ความเร็ว" });
    const slow = within(seg).getByRole("button", { name: "0.75×" });
    expect(within(seg).getByRole("button", { name: "1×" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(slow);
    expect(slow.getAttribute("aria-pressed")).toBe("true");
    expect(engine().tempos.at(-1)).toBe(0.75);
    expect(hero().textContent).toContain("คีย์เดิม");
  });

  it("the play key is the chamfered one, 72 px, and names what it does", async () => {
    mount();
    await pick("Seishin Kakumei", "a.wav");
    const key = within(hero()).getByRole("button", { name: "หยุดชั่วคราว" });
    expect(key.className).toMatch(/\bcut\b/);
    expect(key.className).toMatch(/h-\[72px\]/);
  });
});
