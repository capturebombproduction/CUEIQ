// 2026-10-27 hunt: a setlist snapshot the desktop queue LANDS reaches a Live Mode open on the
// same desktop. The flush broadcasts "setlist-changed", but a client never hears its own
// broadcast (lib/realtime.ts self: false) - and the desktop that queued the edit is the PA
// laptop. So the queue also says it on the window (MGMT_CHILD_LANDED_EVENT) and Live re-reads.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import {
  makeSupabaseFake,
  makeSession,
  ok,
  type SupabaseFake,
} from "@/test/fakes/supabase";
import { MGMT_CHILD_LANDED_EVENT } from "@/lib/mgmt-outbox";
import type { SetlistItem } from "@/lib/types";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  saved: [] as Array<{ itemId: string; blob: Blob; name: string; path: string | null }>,
  pending: [] as Array<{ path: string; resolve: (b: Blob) => void }>,
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  // venue Wi-Fi: an 88 MB master takes minutes - the test decides when it lands
  downloadEventAudio: vi.fn(
    (path: string) => new Promise<Blob>((resolve) => h.pending.push({ path, resolve }))
  ),
}));
vi.mock("@/lib/song-cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/song-cache")>()),
  getCachedSongBlob: vi.fn(async () => null),
  cacheSongBlob: vi.fn(async () => {}),
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

const EVENT_ID = "11111111-2222-4333-8444-555555555555";
const GROUP_ID = "66666666-7777-4888-8999-000000000000";

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  h.saved = [];
  h.pending = [];
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    (b: Blob | MediaSource) => `blob:${(b as Blob & { row?: string }).row ?? "?"}`
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.useRealTimers();
});

describe("LiveMode — the desktop queue landed this show's setlist", () => {
  it("re-reads the set on the window's word, for this show's setlist only", async () => {
    const SET = [makeItem(1), makeItem(2)];
    supa = makeSupabaseFake({
      session: makeSession(),
      script: { setlist_items: ok(SET), songs: ok([]), show_authority: ok([]) },
    });
    h.supa = supa;
    render(
      <LiveMode eventId={EVENT_ID} groupId={GROUP_ID} eventName="Probe" items={SET} songAudio={{}} canEdit={true} lastRunSeconds={null} lastRunAt={null} />
    );
    await act(async () => {});
    await act(async () => {});
    const reads = () => supa.callsTo("setlist_items", "select").length;
    const before = reads();
    const land = async (detail: { eventId: string; kind: string }) => {
      await act(async () => {
        window.dispatchEvent(new CustomEvent(MGMT_CHILD_LANDED_EVENT, { detail }));
      });
      await act(async () => {});
    };
    await land({ eventId: "another-show", kind: "setlist.upsert" });
    await land({ eventId: EVENT_ID, kind: "schedule.upsert" });
    expect(reads()).toBe(before);
    await land({ eventId: EVENT_ID, kind: "setlist.upsert" });
    expect(reads()).toBe(before + 1);
  });
});
