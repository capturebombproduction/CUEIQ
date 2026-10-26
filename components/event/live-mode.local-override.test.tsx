// Hunt 3 (2026-10-27, live). . Harness from components/event/live-mode.download-on-air.test.tsx.
// A song with an online master whose bytes this device already holds in the per-event store
// (a เตรียม / an earlier Live open) gets a LOCAL SOURCE on this device - "ใช้ไฟล์ในเครื่องนี้",
// or (desktop, offline) a replacement upload queued by lib/mgmt-write.ts tryQueueAudioUpload,
// which stores the new bytes AS the local source while songs.audio_path still names the old
// master. Live's own source ladder says the local override wins - but the download effect
// skips the row because cachedPathRef (from the per-event restore) === audio_path.
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
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  downloadEventAudio: vi.fn(() => new Promise<Blob>(() => {})),
}));
vi.mock("@/lib/song-cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/song-cache")>()),
  getCachedSongBlob: vi.fn(async () => null),
  cacheSongBlob: vi.fn(async () => {}),
}));
vi.mock("@/lib/local-source", async (orig) => ({
  ...(await orig<typeof import("@/lib/local-source")>()),
  // the replacement picked on THIS laptop (offline at the venue)
  getLocalSource: vi.fn(async (songId: string) =>
    songId === "song-1" ? { blob: Object.assign(new Blob(["new"]), { row: "local-new" }), name: "fixed.wav" } : null
  ),
  listLocalSourceIds: vi.fn(async () => new Set<string>(["song-1"])),
}));
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => h.saved),
  deleteAudio: vi.fn(async () => {}),
}));

import { LiveMode } from "@/components/event/live-mode";

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
    song_id: null,
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  h.saved = [];
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

describe("live — a local source set after the per-event copy was prepared", () => {
  it("START plays the local override, not the old master held in the per-event store", async () => {
    const SET = [makeItem(1, { song_id: "song-1" }), makeItem(2)];
    supa = makeSupabaseFake({
      session: makeSession(),
      script: {
        setlist_items: ok(SET),
        songs: ok([{ id: "song-1", audio_path: "g/song-1-v1", audio_name: "old.wav" }]),
        show_authority: ok([]),
      },
    });
    h.supa = supa;
    const media = instrumentMediaElements();
    // prepared earlier (เตรียม / a rehearsal open): the R2 master, version g/song-1-v1
    h.saved = [
      { itemId: "item-1", blob: Object.assign(new Blob(["old"]), { row: "item-1-old" }), name: "old.wav", path: "g/song-1-v1" },
    ];
    render(
      <LiveMode
        eventId={EVENT_ID}
        groupId={GROUP_ID}
        eventName="Probe"
        items={SET}
        songAudio={{ "song-1": { path: "g/song-1-v1", name: "old.wav" } }}
        canEdit={true}
        lastRunSeconds={null}
        lastRunAt={null}
      />
    );
    for (let i = 0; i < 6; i++) await act(async () => {});
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    for (let i = 0; i < 4; i++) await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-show"));
    });
    for (let i = 0; i < 4; i++) await act(async () => {});
    const primary = media.first()!;
    // not the per-event copy of the OLD master
    expect(media.state(primary).src).toBe("blob:local-new");
    // …and the per-event record does not vouch for those bytes AS master g/song-1-v1:
    // after "กลับไปใช้ต้นฉบับ" the next open played the discarded take
    const { saveAudio } = await import("@/lib/audio-store");
    const saves = vi.mocked(saveAudio).mock.calls.filter((c) => c[1] === "item-1");
    expect(saves.length).toBeGreaterThan(0);
    expect(saves.map((c) => c[4])).toEqual(saves.map(() => null));
  });
});
