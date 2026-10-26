// Hunt 3 (2026-10-27, live), regression of 19ea761. Harness from live-mode.download-on-air.test.tsx.
// The new post-download on-air deferral `continue`s the loop even when the run was CANCELLED
// (a newer run already owns the rest of the setlist). Before 19ea761 that branch swapped and
// then `if (cancelled) return`. Now a superseded run walks on and re-downloads the same masters
// in parallel with the newer run - two copies of each 30-88 MB file on venue Wi-Fi.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import {
  makeSupabaseFake,
  instrumentMediaElements,
  makeSession,
  ok,
  type SupabaseFake,
  type ChannelFake,
} from "@/test/fakes/supabase";
import { liveTopic } from "@/lib/realtime";
import type { SetlistItem } from "@/lib/types";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  saved: [] as Array<{ itemId: string; blob: Blob; name: string; path: string | null }>,
  pending: [] as Array<{ path: string; resolve: (b: Blob) => void }>,
  cache: new Map<string, Blob>(),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  downloadEventAudio: vi.fn(
    (path: string) => new Promise<Blob>((resolve) => h.pending.push({ path, resolve }))
  ),
}));
vi.mock("@/lib/song-cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/song-cache")>()),
  getCachedSongBlob: vi.fn(async (p: string) => h.cache.get(p) ?? null),
  cacheSongBlob: vi.fn(async (p: string, b: Blob) => {
    h.cache.set(p, b);
  }),
}));
vi.mock("@/lib/local-source", async (orig) => ({
  ...(await orig<typeof import("@/lib/local-source")>()),
  getLocalSource: vi.fn(async () => null),
  listLocalSourceIds: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => h.saved),
  deleteAudio: vi.fn(async () => {}),
}));

import { LiveMode } from "@/components/event/live-mode";
import { downloadEventAudio } from "@/lib/audio-remote";

const EVENT_ID = "11111111-2222-4333-8444-555555555555";
const GROUP_ID = "66666666-7777-4888-8999-000000000000";
const TOPIC = liveTopic(EVENT_ID);

function makeItem(n: number, over: Partial<SetlistItem> = {}): SetlistItem {
  return {
    id: `item-${n}`,
    tenant_id: "tenant-1",
    event_id: EVENT_ID,
    kind: "song",
    title: `Track ${n}`,
    duration_seconds: 240,
    buffer_before_seconds: 0,
    buffer_after_seconds: 0,
    mic_slots: [],
    notes: null,
    sort_order: n,
    song_id: `song-${n}`,
    audio_path: null,
    audio_name: null,
    loop_audio: false,
    ...over,
  };
}

let supa: SupabaseFake;
function live(): ChannelFake {
  const ch = supa.channelFor(TOPIC);
  if (!ch) throw new Error(`no channel opened for ${TOPIC}`);
  return ch;
}
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await act(async () => {});
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  h.saved = [];
  h.pending = [];
  h.cache = new Map();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    (b: Blob | MediaSource) => `blob:${(b as Blob & { row?: string }).row ?? "?"}`
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.useRealTimers();
});

describe("live — a superseded download run stops at the on-air deferral", () => {
  it("Track 3's master is downloaded once, not by both runs", async () => {
    // Songs 1 and 2 were re-uploaded this afternoon (v2); this laptop holds v1 of both.
    const songs = [
      { id: "song-1", audio_path: "g/p1-v2", audio_name: "t1.wav" },
      { id: "song-2", audio_path: "g/p2-v2", audio_name: "t2.wav" },
      { id: "song-3", audio_path: "g/p3", audio_name: "t3.wav" },
    ];
    const SET = [makeItem(1), makeItem(2), makeItem(3)];
    supa = makeSupabaseFake({
      session: makeSession(),
      script: { setlist_items: ok(SET), songs: ok(songs), show_authority: ok([]) },
    });
    h.supa = supa;
    instrumentMediaElements();
    h.saved = [
      { itemId: "item-1", blob: Object.assign(new Blob(["1"]), { row: "item-1-v1" }), name: "t1.wav", path: "g/p1-v1" },
      { itemId: "item-2", blob: Object.assign(new Blob(["2"]), { row: "item-2-v1" }), name: "t2.wav", path: "g/p2-v1" },
    ];
    render(
      <LiveMode
        eventId={EVENT_ID}
        groupId={GROUP_ID}
        eventName="Probe"
        items={SET}
        songAudio={Object.fromEntries(songs.map((s) => [s.id, { path: s.audio_path, name: s.audio_name }]))}
        canEdit={true}
        lastRunSeconds={null}
        lastRunAt={null}
      />
    );
    await flush();
    expect(h.pending.map((p) => p.path)).toEqual(["g/p1-v2"]);
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flush();
    // START: Track 1 from v1
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-show"));
    });
    await flush();
    // its v2 lands while it plays: deferred (19ea761); run 1 goes on to Track 2's v2
    await act(async () => {
      h.pending.find((p) => p.path === "g/p1-v2")!.resolve(Object.assign(new Blob(["1b"]), { row: "item-1-v2" }));
    });
    await flush();
    expect(h.pending.map((p) => p.path)).toContain("g/p2-v2");
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    // Manual: NEXT cues Track 2, RUN plays it (from v1) - Track 1 leaves the air, the retry
    // re-runs the download effect (run 2) and run 1 is cancelled mid-download of Track 2's v2
    await act(async () => {
      fireEvent.click(screen.getByTestId("next"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-toggle"));
    });
    await flush(10);
    // run 1's Track 2 v2 lands, cancelled - Track 2 is on air now, so it is deferred
    await act(async () => {
      h.pending.find((p) => p.path === "g/p2-v2")!.resolve(Object.assign(new Blob(["2b"]), { row: "item-2-v2" }));
    });
    await flush(10);
    const p3 = (downloadEventAudio as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => c[0] === "g/p3"
    ).length;
    // was: the cancelled run walked on to Track 3 too - two downloads of the same master
    expect(p3).toBe(1);
  });
});
