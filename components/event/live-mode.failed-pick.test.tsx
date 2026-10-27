// Hunt 6 (2026-10-27, live). A file picked in Live holds the row's OLD master off while its
// upload runs (pickedRef, hunt 3). When the upload FAILED ("อัปโหลดออนไลน์ไม่สำเร็จ —
// ไฟล์ยังเล่นได้เฉพาะเครื่องนี้") the hold stayed for the session and the download effect skipped
// the row for every later version: linked to another song in the setlist builder, the row played
// the pick under that song's title; a newer master uploaded by the band never reached it. And an
// old master landing after a fast failure was saved over the pick's own per-event record (its
// only copy), so a reload played the old master. The hold is now for the version the row wanted
// at the pick only.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import {
  makeSupabaseFake,
  instrumentMediaElements,
  makeSession,
  ok,
  offline,
  type SupabaseFake,
  type ChannelFake,
  type RecordedCall,
} from "@/test/fakes/supabase";
import { liveTopic, songsTopic } from "@/lib/realtime";
import type { SetlistItem } from "@/lib/types";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  cache: new Map<string, Blob>(),
  pending: [] as Array<{ path: string; resolve: (b: Blob) => void }>,
}));

vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  downloadEventAudio: vi.fn(
    (path: string) => new Promise<Blob>((resolve) => h.pending.push({ path, resolve }))
  ),
  uploadEventAudio: vi.fn(async () => {}),
}));
vi.mock("@/lib/song-cache", async (orig) => ({
  ...(await orig<typeof import("@/lib/song-cache")>()),
  getCachedSongBlob: vi.fn(async (p: string) => h.cache.get(p) ?? null),
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

import { LiveMode } from "@/components/event/live-mode";
import { saveAudio } from "@/lib/audio-store";

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
function ch(topic: string): ChannelFake {
  const c = supa.channelFor(topic);
  if (!c) throw new Error(`no channel opened for ${topic}`);
  return c;
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await act(async () => {});
};
const blob = (row: string) => Object.assign(new Blob([row]), { row });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  h.cache = new Map();
  h.pending = [];
  vi.mocked(saveAudio).mockClear();
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

/** Open Live, then pick a file for row 1 whose temporary song cannot be made (no route out). */
async function pickThatFails(
  rows: SetlistItem[],
  songs: unknown[],
  fileKeyTitle: string,
  /** while the file dialog is open */
  meanwhile: () => Promise<void> = async () => {}
) {
  supa = makeSupabaseFake({
    session: makeSession(),
    script: {
      setlist_items: ok(rows),
      songs: (c: RecordedCall) => (c.verb === "insert" ? offline() : ok(songs)),
      show_authority: ok([]),
    },
  });
  h.supa = supa;
  const media = instrumentMediaElements();
  render(
    <LiveMode eventId={EVENT_ID} groupId={GROUP_ID} eventName="Pick" items={rows} songAudio={{}} canEdit={true} lastRunSeconds={null} lastRunAt={null} />
  );
  await flush();
  await act(async () => {
    ch(TOPIC).setStatus("SUBSCRIBED");
  });
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  await flush();
  await act(async () => {
    fireEvent.click(screen.getAllByTitle(fileKeyTitle)[0]);
  });
  await meanwhile();
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const picked = Object.assign(new File(["x"], "mine.wav", { type: "audio/wav" }), { row: "picked" });
  await act(async () => {
    fireEvent.change(input, { target: { files: [picked] } });
  });
  await flush();
  return media;
}

async function startAndRead(media: ReturnType<typeof instrumentMediaElements>) {
  await act(async () => {
    fireEvent.click(screen.getByTestId("start-show"));
  });
  await flush();
  return media.state(media.first()!).src;
}

const NO_FILE_KEY = "โหลดไฟล์เพลง (อัปโหลดขึ้นคลาวด์)";

describe("LiveMode · a pick in Live whose upload failed (hunt 6)", () => {
  it("the row linked to ANOTHER song in the setlist builder plays that song, not the old pick", async () => {
    const rows = [makeItem(1, { title: "Intro (no file yet)" }), makeItem(2)];
    const media = await pickThatFails(rows, [], NO_FILE_KEY);
    h.cache.set("g/song-b", blob("song-b"));
    supa.setScript({
      setlist_items: ok([{ ...rows[0], song_id: "song-b", title: "Song B" }, rows[1]]),
      songs: ok([{ id: "song-b", audio_path: "g/song-b", audio_name: "b.wav" }]),
      show_authority: ok([]),
    });
    await act(async () => {
      ch(TOPIC).emit("setlist-changed", {});
    });
    await flush();
    expect(await startAndRead(media)).toBe("blob:song-b");
  });

  it("a NEWER master uploaded for the row's song after the pick reaches the row", async () => {
    const rows = [makeItem(1, { song_id: "song-1" }), makeItem(2)];
    const media = await pickThatFails(rows, [{ id: "song-1", audio_path: null, audio_name: null }], NO_FILE_KEY);
    h.cache.set("g/song-1-v2", blob("v2"));
    supa.setScript({
      setlist_items: ok(rows),
      songs: ok([{ id: "song-1", audio_path: "g/song-1-v2", audio_name: "v2.wav" }]),
      show_authority: ok([]),
    });
    await act(async () => {
      ch(songsTopic(GROUP_ID)).emit("changed", {});
    });
    await flush();
    expect(await startAndRead(media)).toBe("blob:v2");
  });

  it("the old master landing after the failed pick wins neither the row nor its per-event record", async () => {
    // venue Wi-Fi: the set is still downloading (Track 1) when the operator opens the file
    // dialog for Track 2; while it is open the loop moves on to Track 2's wrong master
    const rows = [
      makeItem(1, { audio_path: "g/p1", audio_name: "t1.wav" }),
      makeItem(2, { audio_path: "g/p2-wrong", audio_name: "wrong.wav" }),
    ];
    const media = await pickThatFails(rows, [], "มีไฟล์บนคลาวด์ (จะดาวน์โหลดให้อัตโนมัติ) — แตะเพื่อเปลี่ยนไฟล์", async () => {
      await act(async () => {
        h.pending.find((p) => p.path === "g/p1")!.resolve(blob("item-1"));
      });
      await flush();
    });
    // the pick landed while that master was on its way, and its upload failed at once
    const old = h.pending.find((p) => p.path === "g/p2-wrong");
    expect(old).toBeTruthy();
    await act(async () => {
      old!.resolve(blob("p2-wrong"));
    });
    await flush();
    const item2 = vi.mocked(saveAudio).mock.calls.filter((c) => c[1] === "item-2");
    // the pick's own record (path null: the only copy) is the last word for the row
    expect(item2.length).toBeGreaterThan(0);
    expect(item2.some((c) => (c[2] as Blob & { row?: string }).row === "p2-wrong")).toBe(false);
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
