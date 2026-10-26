// 2026-10-27 hunt (livecore). Harness from components/event/live-pads-levels.test.tsx.
// The on-air lock (live-mode.tsx ~1406-1422) is checked BEFORE a row's download awaits, never after
// it: a newer master that started downloading before its row went on air LANDS while that row plays,
// and the download effect revokes the URL the PA is playing (~1494) and swaps in the new one.
// Measured in Electron 45 (scratch probe): a media element whose blob URL is revoked mid-play keeps
// playing what Chromium already read (~36 MB) and then FREEZES for good - no error, no ended, not paused.
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
const tick = async (ms: number) => {
  for (let t = 0; t < ms; t += 250) {
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
  }
};

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

describe("LiveMode — a newer master lands while its row is on air", () => {
  it("the URL the PA is playing is not revoked under it", async () => {
    // The band re-uploaded Track 1's master this afternoon (v2); this laptop prepared v1 yesterday.
    const SET = [
      makeItem(1, { audio_path: "g/item-1-v2" }),
      makeItem(2),
      makeItem(3),
    ];
    supa = makeSupabaseFake({
      session: makeSession(),
      script: { setlist_items: ok(SET), songs: ok([]), show_authority: ok([]) },
    });
    h.supa = supa;
    const media = instrumentMediaElements();
    h.saved = [
      { itemId: "item-1", blob: Object.assign(new Blob(["v1"]), { row: "item-1-v1" }), name: "t1.wav", path: "g/item-1-v1" },
      { itemId: "item-2", blob: Object.assign(new Blob(["2"]), { row: "item-2" }), name: "t2.wav", path: null },
      { itemId: "item-3", blob: Object.assign(new Blob(["3"]), { row: "item-3" }), name: "t3.wav", path: null },
    ];
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    render(
      <LiveMode eventId={EVENT_ID} groupId={GROUP_ID} eventName="Probe" items={SET} songAudio={{}} canEdit={true} lastRunSeconds={null} lastRunAt={null} />
    );
    await act(async () => {});
    await act(async () => {});
    // the v2 download is on its way ("กำลังโหลดเสียงลงเครื่อง…")
    expect(h.pending.map((p) => p.path)).toContain("g/item-1-v2");
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    // START: Track 1 opens the show from the bytes this laptop holds (v1)
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-show"));
    });
    const primary = media.first()!;
    expect(media.state(primary).src).toBe("blob:item-1-v1");
    expect(media.state(primary).paused).toBe(false);
    await tick(60_000);
    // a minute into the song, v2 lands
    await act(async () => {
      h.pending.find((p) => p.path === "g/item-1-v2")!.resolve(Object.assign(new Blob(["v2"]), { row: "item-1-v2" }));
    });
    await act(async () => {});
    await act(async () => {});
    // still Track 1, still the v1 bytes on the element...
    expect(media.state(primary).src).toBe("blob:item-1-v1");
    expect(media.state(primary).paused).toBe(false);
    // BUG: ...whose URL was just revoked under it (Chromium: frozen ~36 MB in, the PA silent)
    expect(revoke.mock.calls.map((c) => c[0])).not.toContain("blob:item-1-v1");
  });
});

describe("LiveMode — same, the MC's Loop bed (Electron 45: MEDIA_ERR_NETWORK at its next wrap)", () => {
  it("the URL the PA is playing is not revoked under it", async () => {
    // The band re-uploaded Track 1's master this afternoon (v2); this laptop prepared v1 yesterday.
    const SET = [
      makeItem(1, { kind: "mc", title: "MC BGM", loop_audio: true, duration_seconds: 300, audio_path: "g/item-1-v2" }),
      makeItem(2),
      makeItem(3),
    ];
    supa = makeSupabaseFake({
      session: makeSession(),
      script: { setlist_items: ok(SET), songs: ok([]), show_authority: ok([]) },
    });
    h.supa = supa;
    const media = instrumentMediaElements();
    h.saved = [
      { itemId: "item-1", blob: Object.assign(new Blob(["v1"]), { row: "item-1-v1" }), name: "t1.wav", path: "g/item-1-v1" },
      { itemId: "item-2", blob: Object.assign(new Blob(["2"]), { row: "item-2" }), name: "t2.wav", path: null },
      { itemId: "item-3", blob: Object.assign(new Blob(["3"]), { row: "item-3" }), name: "t3.wav", path: null },
    ];
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    render(
      <LiveMode eventId={EVENT_ID} groupId={GROUP_ID} eventName="Probe" items={SET} songAudio={{}} canEdit={true} lastRunSeconds={null} lastRunAt={null} />
    );
    await act(async () => {});
    await act(async () => {});
    // the v2 download is on its way ("กำลังโหลดเสียงลงเครื่อง…")
    expect(h.pending.map((p) => p.path)).toContain("g/item-1-v2");
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    // START: Track 1 opens the show from the bytes this laptop holds (v1)
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-show"));
    });
    const primary = media.first()!;
    expect(media.state(primary).src).toBe("blob:item-1-v1");
    expect(media.state(primary).paused).toBe(false);
    await tick(60_000);
    // a minute into the song, v2 lands
    await act(async () => {
      h.pending.find((p) => p.path === "g/item-1-v2")!.resolve(Object.assign(new Blob(["v2"]), { row: "item-1-v2" }));
    });
    await act(async () => {});
    await act(async () => {});
    // still Track 1, still the v1 bytes on the element...
    expect(media.state(primary).src).toBe("blob:item-1-v1");
    expect(media.state(primary).paused).toBe(false);
    // BUG: ...whose URL was just revoked under it (Chromium: frozen ~36 MB in, the PA silent)
    expect(revoke.mock.calls.map((c) => c[0])).not.toContain("blob:item-1-v1");
  });
});
