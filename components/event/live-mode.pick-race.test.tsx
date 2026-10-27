// Hunt 6 (2026-10-27, live; Argon's review of the pick fix). Two files picked in Live for the
// same row raced: the OLDER pick's slow upload, finishing last, still linked the row back to its
// temporary song (setlist_items.song_id) on every device - the newer pick was lost. And the older
// pick's link, landing while the newer pick waited, REPLACED the version that pick held off, so
// the row's old master still on its way got through and played over the newer pick. Now each
// pick carries a per-row sequence token (only the newest links) and holds a SET of versions.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import {
  makeSupabaseFake,
  instrumentMediaElements,
  makeSession,
  ok,
  type SupabaseFake,
  type ChannelFake,
  type RecordedCall,
} from "@/test/fakes/supabase";
import { liveTopic } from "@/lib/realtime";
import type { SetlistItem } from "@/lib/types";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  downloads: [] as Array<{ path: string; resolve: (b: Blob) => void }>,
  uploads: [] as Array<{ path: string; resolve: () => void }>,
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  downloadEventAudio: vi.fn(
    (path: string) => new Promise<Blob>((resolve) => h.downloads.push({ path, resolve }))
  ),
  uploadEventAudio: vi.fn(
    (path: string) => new Promise<void>((resolve) => h.uploads.push({ path, resolve }))
  ),
  removeEventAudio: vi.fn(async () => {}),
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
// jsdom's <audio> never answers: the pick's open check (audioOpenProblem) would wait out its 3 s
vi.mock("@/lib/audio", async (orig) => ({ ...(await orig<typeof import("@/lib/audio")>()), audioOpenProblem: vi.fn(async () => null) }));
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => []),
  deleteAudio: vi.fn(async () => {}),
}));
vi.mock("@/lib/song-file-facts", () => ({ writeSongFileFacts: vi.fn(async () => {}) }));

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
let made = 0;
function live(): ChannelFake {
  const c = supa.channelFor(TOPIC);
  if (!c) throw new Error(`no channel opened for ${TOPIC}`);
  return c;
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await act(async () => {});
};
const microtasks = async (n = 30) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
const blob = (row: string) => Object.assign(new Blob([row]), { row });
const file = (row: string) => Object.assign(new File([row], `${row}.wav`, { type: "audio/wav" }), { row });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  h.downloads = [];
  h.uploads = [];
  made = 0;
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

async function open(rows: SetlistItem[]) {
  supa = makeSupabaseFake({
    session: makeSession(),
    script: {
      setlist_items: (c: RecordedCall) => (c.verb === "select" ? ok(rows) : ok([{ id: "item-2" }])),
      songs: (c: RecordedCall) =>
        c.verb === "insert" ? ok({ id: `temp-${++made}` }) : c.verb === "update" ? ok([{ id: "temp" }]) : ok([]),
      show_authority: ok([]),
    },
  });
  h.supa = supa;
  const media = instrumentMediaElements();
  render(
    <LiveMode eventId={EVENT_ID} groupId={GROUP_ID} eventName="Picks" items={rows} songAudio={{}} canEdit={true} lastRunSeconds={null} lastRunAt={null} />
  );
  await flush();
  await act(async () => {
    live().setStatus("SUBSCRIBED");
  });
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  await flush();
  return media;
}

/** The file dialog for `title`'s key, answered (each answer is a pick on that row). */
async function openDialog(title: string) {
  await act(async () => {
    fireEvent.click(screen.getAllByTitle(title)[0]);
  });
}
async function choose(row: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [file(row)] } });
  });
  await flush();
}
const links = () =>
  supa.callsTo("setlist_items", "update").map((c) => (c.values as { song_id?: string }).song_id);

async function playTrack2(media: ReturnType<typeof instrumentMediaElements>) {
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
  return media.state(media.first()!).src;
}

describe("LiveMode · two picks on one row (hunt 6)", () => {
  it("the newest pick stays linked and playing when the older pick's upload finishes last", async () => {
    const rows = [makeItem(1, { audio_path: "g/p1", audio_name: "t1.wav" }), makeItem(2)];
    const media = await open(rows);
    await act(async () => {
      h.downloads.find((d) => d.path === "g/p1")!.resolve(blob("item-1"));
    });
    await flush();
    await openDialog("โหลดไฟล์เพลง (อัปโหลดขึ้นคลาวด์)");
    await choose("one"); // a long WAV: its upload crawls
    await choose("two"); // the fix, picked again: a short file
    expect(h.uploads).toHaveLength(2);
    await act(async () => {
      h.uploads[1].resolve(); // "two" lands first
    });
    await flush();
    await act(async () => {
      h.uploads[0].resolve(); // "one" lands last
    });
    await flush();
    // the row is linked once, to the newest pick's song - on every device
    expect(links()).toEqual(["temp-2"]);
    expect(await playTrack2(media)).toBe("blob:two");
  });

  it("the row's old master still on its way does not get through when an older pick's link lands", async () => {
    const rows = [
      makeItem(1, { audio_path: "g/p1", audio_name: "t1.wav" }),
      makeItem(2, { audio_path: "g/p2-old", audio_name: "old.wav" }),
    ];
    const media = await open(rows);
    // the file dialog for Track 2 opens while Track 1 downloads; meanwhile Track 2's old
    // master starts on its way
    await openDialog("มีไฟล์บนคลาวด์ (จะดาวน์โหลดให้อัตโนมัติ) — แตะเพื่อเปลี่ยนไฟล์");
    await act(async () => {
      h.downloads.find((d) => d.path === "g/p1")!.resolve(blob("item-1"));
    });
    await flush();
    const old = h.downloads.find((d) => d.path === "g/p2-old");
    expect(old).toBeTruthy();
    await choose("one");
    await choose("two");
    // the older pick's upload ends, and the old master lands right behind it, before the
    // screen has re-rendered
    await act(async () => {
      h.uploads[0].resolve();
      await microtasks();
      old!.resolve(blob("p2-old"));
      await microtasks();
    });
    await flush();
    expect(await playTrack2(media)).toBe("blob:two");
  });
});
