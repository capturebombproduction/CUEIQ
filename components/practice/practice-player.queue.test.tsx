// The Add to Queue picker says "เลือกต่อได้หลายเพลง", so it has to survive the
// list it feeds changing under it. Its open state is its own, so the one picker
// must sit at the same place in the tree whether the queue is empty or not: an
// empty room's first pick (or a song another phone adds while it is open) used
// to swap the empty slab for the list and close it mid-choice.
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { PracticeSong, Song, SongMarker } from "@/lib/types";

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    playing = false;
    onTime = () => {};
    onDuration = () => {};
    onPlayingChange = () => {};
    onEnded = () => {};
    onPreparing = () => {};
    onStretchFailed = () => {};
    unlock() {}
    async load() {}
    async play() {}
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
const h = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      let inserted: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        gte: () => b,
        in: () => b,
        order: () => b,
        insert: (row: Record<string, unknown>) => {
          inserted = row;
          return b;
        },
        // practice_songs insert → the row the server would hand back
        single: () =>
          Promise.resolve({ data: { id: `ps-${++h.n}`, ...(inserted ?? {}) }, error: null }),
        // every other read: nothing (no shows → the setlist card stays out of the way)
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
      };
      return b;
    },
  }),
}));

import { PracticePlayer } from "./practice-player";

const song = (id: string, title: string): Song =>
  ({ id, tenant_id: "t1", group_id: "g1", title, duration_seconds: 228, audio_path: `${id}.wav` }) as Song;
const songs = [song("a", "Seishin Kakumei"), song("b", "Neon Samurai"), song("c", "Akai Hana")];

/** A room whose list lives in real state, as on the page; `push` stands in for a
 *  realtime insert from another phone. */
let push: (item: PracticeSong) => void = () => {};
function Room({ start }: { start: PracticeSong[] }) {
  const [items, setItems] = useState<PracticeSong[]>(start);
  const [markers, setMarkers] = useState<Record<string, SongMarker[]>>({});
  push = (item) => setItems((prev) => [...prev, item]);
  return (
    <ConfirmProvider>
      <PracticePlayer
        roomName="ห้องซ้อม"
        eventId="room"
        groupId="g1"
        currentUserId="u1"
        songs={songs}
        items={items}
        setItems={setItems}
        markers={markers}
        setMarkers={setMarkers}
        canManage
        canCurate
      />
    </ConfirmProvider>
  );
}

// the open picker hides the rest of the page from the a11y tree (Radix), so the
// queue is read with hidden: true
const queue = () => screen.getByRole("region", { name: "Queue", hidden: true });

async function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: /เพิ่มเพลง/ }));
  return screen.findByRole("dialog");
}

describe("PracticePlayer — the Add to Queue picker", () => {
  it("stays open after the first song goes into an empty room", async () => {
    render(<Room start={[]} />);
    const dlg = await openPicker();
    fireEvent.click(within(dlg).getByRole("button", { name: /Neon Samurai/ }));
    // the song has landed in the queue (the picker no longer offers it)…
    await waitFor(() =>
      expect(queue().textContent).toContain("Neon Samurai")
    );
    // …and the picker is still up, ready for the next one
    const still = screen.getByRole("dialog");
    expect(within(still).queryByRole("button", { name: /Neon Samurai/ })).toBeNull();
    expect(within(still).getByRole("button", { name: /Akai Hana/ })).toBeTruthy();
  });

  it("stays open when another phone adds the room's first song while it is open", async () => {
    render(<Room start={[]} />);
    await openPicker();
    push({ id: "remote-1", song_id: "a", sort_order: 1 } as PracticeSong);
    await waitFor(() =>
      expect(queue().textContent).toContain("Seishin Kakumei")
    );
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("an empty room still shows one way in, and a room with songs keeps it", async () => {
    const { unmount } = render(<Room start={[]} />);
    expect(screen.getAllByRole("button", { name: /เพิ่มเพลง/ })).toHaveLength(1);
    unmount();
    render(<Room start={[{ id: "p0", song_id: "a", sort_order: 1 } as PracticeSong]} />);
    expect(screen.getAllByRole("button", { name: /เพิ่มเพลง/ })).toHaveLength(1);
  });
});
