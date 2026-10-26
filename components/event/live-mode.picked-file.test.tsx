// Hunt 3 (2026-10-27, live), pre-existing. Harness from live-mode.download-on-air.test.tsx.
// A file picked in Live for a row (handleFileChange: the "change the file" key on a running-order
// row) plays at once and starts its long upload. While that upload is on its way, the download
// effect reaches the same row and pulls the row's OLD library master: it lands, revokes the picked
// file's URL and swaps the old master in. When the upload finally links the new song, cachedPathRef
// already equals the new path, so nothing ever swaps back - the replaced file plays on stage.
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
  // an 88 MB WAV going up on venue Wi-Fi: still on its way when the test ends
  uploadEventAudio: vi.fn(() => new Promise<void>(() => {})),
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

describe("live — a file picked in Live while the setlist is still downloading", () => {
  it("the row plays the picked file, not its old master that landed after the pick", async () => {
    const SET = [
      makeItem(1, { audio_path: "g/p1", audio_name: "t1.wav" }),
      makeItem(2, { audio_path: "g/p2-wrong", audio_name: "t2.wav" }),
    ];
    supa = makeSupabaseFake({
      session: makeSession(),
      script: {
        setlist_items: ok(SET),
        songs: ok([{ id: "temp-song", audio_path: null, audio_name: null }]),
        show_authority: ok([]),
      },
    });
    h.supa = supa;
    const media = instrumentMediaElements();
    const revoke = URL.revokeObjectURL as unknown as { mock: { calls: unknown[][] } };
    render(
      <LiveMode eventId={EVENT_ID} groupId={GROUP_ID} eventName="Probe" items={SET} songAudio={{}} canEdit={true} lastRunSeconds={null} lastRunAt={null} />
    );
    await flush();
    // venue Wi-Fi: the loop is still on Track 1's master
    expect(h.pending.map((p) => p.path)).toEqual(["g/p1"]);
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flush();
    // the admin replaces Track 2's (wrong) file from this laptop
    await act(async () => {
      fireEvent.click(screen.getByTitle("มีไฟล์บนคลาวด์ (จะดาวน์โหลดให้อัตโนมัติ) — แตะเพื่อเปลี่ยนไฟล์"));
    });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const picked = Object.assign(new File(["fixed"], "fixed.wav", { type: "audio/wav" }), { row: "picked" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [picked] } });
    });
    await flush();
    // Track 1's master lands; the loop moves on to Track 2 and fetches its OLD master
    await act(async () => {
      h.pending.find((p) => p.path === "g/p1")!.resolve(Object.assign(new Blob(["1"]), { row: "item-1" }));
    });
    await flush();
    const old = h.pending.find((p) => p.path === "g/p2-wrong");
    if (old) {
      await act(async () => {
        old.resolve(Object.assign(new Blob(["2"]), { row: "item-2-wrong" }));
      });
      await flush();
    }
    expect(revoke.mock.calls.map((c) => c[0])).not.toContain("blob:picked");
    // and on stage: START, NEXT, RUN - Track 2 must be the picked file
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-show"));
    });
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("next"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("run-toggle"));
    });
    await flush();
    expect(media.state(media.first()!).src).toBe("blob:picked");
  });
});
