// "ซ้อมตามเซ็ตลิสต์" — the band rehearses the next show's set in order (88 logged
// runs say so), and the player used to stop after every song. What this pins is
// the part no screenshot shows: a song ENDING starts the next one, the set ends
// itself, and picking some other song by hand leaves the run instead of being
// yanked back into it when that song ends.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { bkkTodayKey } from "@/lib/time";
import type { PracticeSong, Song } from "@/lib/types";

type FakeEngine = { loads: string[]; onEnded: () => void };
const h = vi.hoisted(() => ({ engines: [] as FakeEngine[], shows: [] as unknown[] }));

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    loads: string[] = [];
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
vi.mock("@/lib/song-cache", () => ({ getSongBlob: async (path: string) => ({ path }) }));
vi.mock("@/lib/local-source", () => ({
  getLocalSource: async () => null,
  listLocalSourceIds: async () => [],
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/bpm-detect", () => ({ detectBeats: () => null }));
vi.mock("@/components/practice/metronome", () => ({ Metronome: () => null }));
vi.mock("@/components/practice/break-timer", () => ({ BreakTimer: () => null }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const b = {
        select: () => b,
        eq: () => b,
        gte: () => b,
        insert: () => b,
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(
            table === "events" ? { data: h.shows, error: null } : { data: null, error: null }
          ).then(res),
      };
      return b;
    },
  }),
}));

import { PracticePlayer } from "./practice-player";

const song = (id: string, title: string): Song =>
  ({ id, tenant_id: "t1", group_id: "g1", title, duration_seconds: 200, audio_path: `${id}.wav` }) as Song;
const songs = [
  song("boot", "[SYSTEM_BOOT] SE"),
  song("neon", "Neon Lullaby"),
  song("iam", "I Am Who I Am"),
  song("other", "Transmission Failure"),
];
const row = (id: string, sort: number, song_id: string | null, kind = "song") => ({
  id,
  title: id,
  kind,
  song_id,
  sort_order: sort,
});
const items = [{ id: "p1", song_id: "other", sort_order: 1 } as PracticeSong];

beforeEach(() => {
  h.engines = [];
  toastSuccess.mockClear();
  h.shows = [
    {
      id: "show-1",
      name: "Thailand hobbyfestival",
      event_date: bkkTodayKey(),
      setlist_items: [
        row("r1", 1, "boot"),
        row("r2", 2, "neon"),
        row("mc", 3, null, "mc"),
        row("r3", 4, "iam"),
      ],
    },
  ];
});

const mount = () =>
  render(
    <ConfirmProvider>
      <PracticePlayer
        eventId="room"
        groupId="g1"
        currentUserId="u1"
        songs={songs}
        items={items}
        setItems={() => {}}
        markers={{}}
        setMarkers={() => {}}
        canManage={false}
        canCurate={false}
      />
    </ConfirmProvider>
  );
const engine = () => h.engines[h.engines.length - 1];
const end = () => act(() => engine().onEnded());

describe("PracticePlayer — ซ้อมตามเซ็ตลิสต์", () => {
  it("plays the set in order, each song starting as the last one ends, then stops", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /เล่นทั้งเซ็ต \(3 เพลง\)/ }));
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav"]));

    end();
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "neon.wav"]));
    // the MC row is not a song — the run goes straight past it
    end();
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "neon.wav", "iam.wav"]));

    end();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("ซ้อมครบทั้งเซ็ตแล้ว"));
    expect(engine().loads).toHaveLength(3);
    expect(screen.getByRole("button", { name: /เล่นทั้งเซ็ต/ })).toBeTruthy();
  });

  it("picking another song by hand leaves the run — its end does not jump back into the set", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /เล่นทั้งเซ็ต/ }));
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav"]));

    fireEvent.click(screen.getByRole("button", { name: /Transmission Failure/ }));
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "other.wav"]));

    end();
    await new Promise((r) => setTimeout(r, 30));
    expect(engine().loads).toEqual(["boot.wav", "other.wav"]);
  });

  it("a song ending with no run going does nothing", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Transmission Failure/ }));
    await waitFor(() => expect(engine().loads).toEqual(["other.wav"]));
    end();
    await new Promise((r) => setTimeout(r, 30));
    expect(engine().loads).toEqual(["other.wav"]);
  });
});
