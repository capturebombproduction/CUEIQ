// Hunt 6 (2026-10-27, live; Argon's review of the queued-take fix). A queued take is HELD
// local when it leaves this device's local sources (live-mode.tsx heldLocalRef) - a judgement
// made between two reads of the local sources. The reads were "latest wins": a read still in
// flight was thrown away when a newer one started. The take queued (read 1: local + queued, slow
// to settle) and then flushed (read 2: gone) - read 1 was dropped, the take was never seen, the
// transition never happened, and nothing re-read the server: the row stayed on the master the
// take replaced. The reads now run one after another, each applied, none dropped.
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
import { MGMT_OUTBOX_EVENT } from "@/lib/mgmt-outbox";
import { registerPendingAudioReader } from "@/lib/mgmt-write";
import type { SetlistItem } from "@/lib/types";

type Read = { local: string[]; pending: string[]; gate?: Promise<void> };
const h = vi.hoisted(() => ({
  supa: null as unknown,
  reads: [] as Read[],
  localCalls: 0,
  pendingCalls: 0,
}));
const nth = (i: number) => h.reads[Math.min(i, h.reads.length - 1)];

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  downloadEventAudio: vi.fn(() => new Promise<Blob>(() => {})),
}));
vi.mock("@/lib/song-cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/song-cache")>()),
  getCachedSongBlob: vi.fn(async (path: string) =>
    path === "g/song-1-v1"
      ? Object.assign(new Blob(["old"]), { row: "master-v1" })
      : path === "g/song-1-v2"
        ? Object.assign(new Blob(["new"]), { row: "take-v2" })
        : null
  ),
  cacheSongBlob: vi.fn(async () => {}),
}));
vi.mock("@/lib/local-source", async (orig) => ({
  ...(await orig<typeof import("@/lib/local-source")>()),
  // the take is already gone from the store by the time anything asks for its bytes
  getLocalSource: vi.fn(async () => null),
  listLocalSourceIds: vi.fn(async () => {
    const r = nth(h.localCalls++);
    await r.gate;
    return new Set(r.local);
  }),
}));
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => []),
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

const SET = [makeItem(1, { song_id: "song-1" }), makeItem(2)];
let supa: SupabaseFake;
function live(): ChannelFake {
  const ch = supa.channelFor(TOPIC);
  if (!ch) throw new Error(`no channel opened for ${TOPIC}`);
  return ch;
}
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => {});
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  h.localCalls = 0;
  h.pendingCalls = 0;
  registerPendingAudioReader(async () => new Set(nth(h.pendingCalls++).pending));
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    (b: Blob | MediaSource) => `blob:${(b as Blob & { row?: string }).row ?? "?"}`
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  registerPendingAudioReader(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.useRealTimers();
});

describe("LiveMode · the local-source reads are applied in order (hunt 6)", () => {
  it("a take queued and flushed between two overlapping reads still reaches its new master", async () => {
    let settleQueued!: () => void;
    h.reads = [
      { local: [], pending: [] }, // the open: nothing local yet, the master v1 plays
      { local: ["song-1"], pending: ["song-1"], gate: new Promise<void>((r) => (settleQueued = r)) }, // queued
      { local: [], pending: [] }, // flushed
    ];
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
    render(
      <LiveMode
        eventId={EVENT_ID}
        groupId={GROUP_ID}
        eventName="Reads"
        items={SET}
        songAudio={{ "song-1": { path: "g/song-1-v1", name: "old.wav" } }}
        canEdit={true}
        lastRunSeconds={null}
        lastRunAt={null}
      />
    );
    await flush(6);
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flush(4);
    // the take is queued at the venue (read 1, slow to settle) and lands before it does
    await act(async () => {
      window.dispatchEvent(new Event(MGMT_OUTBOX_EVENT));
    });
    supa.setScript({
      setlist_items: ok(SET),
      songs: ok([{ id: "song-1", audio_path: "g/song-1-v2", audio_name: "fixed.wav" }]),
      show_authority: ok([]),
    });
    await act(async () => {
      window.dispatchEvent(new Event(MGMT_OUTBOX_EVENT));
    });
    await flush();
    await act(async () => {
      settleQueued();
    });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-show"));
    });
    await flush(4);
    expect(media.state(media.first()!).src).toBe("blob:take-v2");
  });
});
