// A section mark is filed once per press. Until 2026-10-27 (hunt 7) addMarker had no in-flight
// guard: a double tap on "+ Intro" on an iPad, or Enter twice in the label box on a slow link,
// inserted the same section twice - same label, same place, same sort_order - and nothing in
// song_markers refuses a duplicate. The keys now wait for the mark on its way.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { PracticeSong, Song, SongMarker } from "@/lib/types";

const h = vi.hoisted(() => ({
  engines: [] as { loads: string[] }[],
  inserts: [] as unknown[],
  release: null as null | ((v: unknown) => void),
}));

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    loads: string[] = [];
    playing = false;
    currentTime = 12;
    onTime: (t: number) => void = () => {};
    onDuration: (d: number) => void = () => {};
    onPlayingChange: (p: boolean) => void = () => {};
    onEnded: () => void = () => {};
    onPreparing: (p: boolean) => void = () => {};
    onStretchFailed: (e: unknown) => void = () => {};
    constructor() {
      h.engines.push(this);
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
    }
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
      const b = {
        select: () => b,
        eq: () => b,
        gte: () => b,
        order: () => b,
        insert: (row: unknown) => {
          if (table === "song_markers") {
            h.inserts.push(row);
            inserting = true;
          }
          return b;
        },
        // the mark's insert stays on the wire until the test lets it land
        single: () =>
          inserting
            ? new Promise((r) => {
                h.release = r;
              })
            : Promise.resolve({ data: null, error: null }),
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
      };
      return b;
    },
  }),
}));

import { PracticePlayer } from "./practice-player";

const song = (id: string, title: string): Song =>
  ({ id, tenant_id: "t1", group_id: "g1", title, duration_seconds: 228, audio_path: `${id}.wav` }) as Song;
const songs = [song("a", "Seishin Kakumei")];
const items = songs.map((s, i) => ({ id: `p-${s.id}`, song_id: s.id, sort_order: i }) as PracticeSong);
const markers: Record<string, SongMarker[]> = { a: [] };

async function openMarks() {
  render(
    <ConfirmProvider>
      <PracticePlayer
        roomName="ห้องซ้อม"
        eventId="room"
        groupId="g1"
        currentUserId="u1"
        songs={songs}
        items={items}
        setItems={() => {}}
        markers={markers}
        setMarkers={() => {}}
        canManage={false}
        canCurate
      />
    </ConfirmProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: /Seishin Kakumei/ }));
  await waitFor(() => expect(h.engines.at(-1)?.loads).toContain("a.wav"));
  // no marks yet: the preset chips and the label box are on screen as they are
}

beforeEach(() => {
  h.engines = [];
  h.inserts = [];
  h.release = null;
});

describe("PracticePlayer — a section mark is filed once per press", () => {
  it("a double tap on a preset chip inserts one mark, and the chips wait for it", async () => {
    await openMarks();
    const intro = screen.getByRole("button", { name: /^Intro$/ });
    fireEvent.click(intro);
    fireEvent.click(intro);
    expect(h.inserts).toHaveLength(1);
    expect(intro).toBeDisabled();
  });

  it("Enter twice in the label box inserts one mark", async () => {
    await openMarks();
    const box = screen.getByRole("textbox", { name: "ชื่อท่อนเอง" });
    fireEvent.change(box, { target: { value: "Drop" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter", repeat: true });
    expect(h.inserts).toHaveLength(1);
  });

  it("once the mark has landed (or failed), the next press files the next one", async () => {
    await openMarks();
    const intro = screen.getByRole("button", { name: /^Intro$/ });
    fireEvent.click(intro);
    h.release?.({ data: null, error: { message: "network" } });
    await waitFor(() => expect(intro).not.toBeDisabled());
    fireEvent.click(intro);
    expect(h.inserts).toHaveLength(2);
  });
});
