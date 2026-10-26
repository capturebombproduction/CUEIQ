// Hunt 6 (2026-10-27, live). A take replaced OFFLINE on the desktop is queued (lib/mgmt-write.ts
// tryQueueAudioUpload): its bytes are the song's LOCAL SOURCE and songs.audio_path still names the
// old master, so Live plays the take (hunt 3). When the queue LANDS (desktop/src/data/mgmt-outbox.ts:
// audio_path written, "changed" sent on Live's OWN songs channel - self:false, never heard here -
// the take cached under its new key, the old master deleted from R2, clearLocalSource, notify),
// Live re-listed its local ids, the row fell back to its stale audio_path and loaded the OLD master
// out of the library cache over the take, every indicator green. Now a queued take that leaves
// the local set is held until a server read issued after it left has been applied; an override
// cleared by hand ("กลับไปใช้ต้นฉบับ", nothing queued) goes back to the master at once.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import {
  makeSupabaseFake,
  instrumentMediaElements,
  makeSession,
  ok,
  fail,
  type SupabaseFake,
  type ChannelFake,
} from "@/test/fakes/supabase";
import { liveTopic } from "@/lib/realtime";
import { MGMT_OUTBOX_EVENT } from "@/lib/mgmt-outbox";
import { registerPendingAudioReader } from "@/lib/mgmt-write";
import type { SetlistItem } from "@/lib/types";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  local: true,
  pending: new Set<string>(),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  downloadEventAudio: vi.fn(() => new Promise<Blob>(() => {})),
}));
vi.mock("@/lib/song-cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/song-cache")>()),
  // the library cache holds the OLD master (current until the flush) and the take under its
  // new key (the flush's cacheSongBlob)
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
  getLocalSource: vi.fn(async (songId: string) =>
    h.local && songId === "song-1"
      ? { blob: Object.assign(new Blob(["new"]), { row: "take-local" }), name: "fixed.wav" }
      : null
  ),
  listLocalSourceIds: vi.fn(async () => new Set<string>(h.local ? ["song-1"] : [])),
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
const minted = () =>
  (URL.createObjectURL as unknown as { mock: { results: { value: string }[] } }).mock.results.map((r) => r.value);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  h.local = true;
  h.pending = new Set();
  registerPendingAudioReader(async () => new Set(h.pending));
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

/** Live open on the take (song-1's local source), master v1 online. */
async function openOnTheTake() {
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
      eventName="Queued take"
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
  expect(minted()).toContain("blob:take-local");
  return media;
}

/** The outbox changed: this device's local sources (and queued uploads) are re-read. */
async function outboxChanged() {
  await act(async () => {
    window.dispatchEvent(new Event(MGMT_OUTBOX_EVENT));
  });
  await flush();
}

async function startAndRead(media: ReturnType<typeof instrumentMediaElements>) {
  await act(async () => {
    fireEvent.click(screen.getByTestId("start-show"));
  });
  await flush(4);
  return media.state(media.first()!).src;
}

describe("LiveMode · a queued take lands while Live is open (hunt 6)", () => {
  it("the row goes from the take to its new master, never through the old one", async () => {
    h.pending = new Set(["song-1"]); // queued at the venue, waiting for the network
    const media = await openOnTheTake();
    await outboxChanged(); // the queue is re-read: still waiting, nothing moves
    expect(minted()).not.toContain("blob:master-v1");
    // the queue lands: the server names v2, the take is no local source any more
    supa.setScript({
      setlist_items: ok(SET),
      songs: ok([{ id: "song-1", audio_path: "g/song-1-v2", audio_name: "fixed.wav" }]),
      show_authority: ok([]),
    });
    h.local = false;
    h.pending = new Set();
    await outboxChanged();
    expect(minted()).not.toContain("blob:master-v1");
    expect(await startAndRead(media)).toBe("blob:take-v2");
    expect(minted()).not.toContain("blob:master-v1");
  });

  it("a landed take whose server read cannot be applied keeps playing the take, not the old master", async () => {
    h.pending = new Set(["song-1"]);
    const media = await openOnTheTake();
    await outboxChanged();
    // the venue link drops again right after the flush: the songs read fails
    supa.setScript({
      setlist_items: ok(SET),
      songs: fail("TypeError: Failed to fetch", 0),
      show_authority: ok([]),
    });
    h.local = false;
    h.pending = new Set();
    await outboxChanged();
    expect(await startAndRead(media)).toBe("blob:take-local");
    expect(minted()).not.toContain("blob:master-v1");
  });

  it("กลับไปใช้ต้นฉบับ (an override, nothing queued): the row goes back to the master at once", async () => {
    const media = await openOnTheTake();
    // the override is cleared; the server's master is unchanged - and no read is needed
    supa.setScript({
      setlist_items: ok(SET),
      songs: fail("TypeError: Failed to fetch", 0),
      show_authority: ok([]),
    });
    h.local = false;
    await outboxChanged();
    expect(await startAndRead(media)).toBe("blob:master-v1");
  });
});
