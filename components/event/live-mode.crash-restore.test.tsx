// A show that died mid-song and came back minutes later (2026-11-05, hunt 13).
//
// The crash-recovery snapshot's timestamps are absolute, which is right for a page that
// comes straight back (a reload, a renderer that crashed and reloaded itself). A PA killed
// or rebooted mid-song is minutes, and the snapshot came back with the row's clock run on
// through the whole outage while the file had stood still: in AUTO the song that was cut
// was over by its clock and the next one took over at the first render (its clock running,
// silent until someone tapped, then joined seconds in); in MANUAL the rescue tap played the
// file from the wall clock - 5:03 into a 4:00 file, silence. Now a page gone longer than
// RESUME_RUNNING_MS comes back PAUSED on the row it stood on, at the position it had when
// it was last alive, still the show (not held: it keeps MAIN), and play goes on from there.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import {
  makeSupabaseFake,
  instrumentMediaElements,
  makeSession,
  ok,
  type SupabaseFake,
  type ChannelFake,
  type MediaInstrumentation,
} from "@/test/fakes/supabase";
import { liveTopic } from "@/lib/realtime";
import type { SetlistItem } from "@/lib/types";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  saved: [] as Array<{ itemId: string; blob: Blob; name: string; path: string | null }>,
}));
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  message: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
// jsdom's <audio> never answers: the open check would wait out its 3 s
vi.mock("@/lib/audio", async (orig) => ({ ...(await orig<typeof import("@/lib/audio")>()), audioOpenProblem: vi.fn(async () => null) }));
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => h.saved),
  deleteAudio: vi.fn(async () => {}),
}));

import { LiveMode } from "./live-mode";

const EVENT_ID = "11111111-2222-4333-8444-555555555555";
const GROUP_ID = "66666666-7777-4888-8999-000000000000";
const TOPIC = liveTopic(EVENT_ID);
const SNAPSHOT_KEY = `cueiq:live:${EVENT_ID}`;

function makeItem(n: number): SetlistItem {
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
  };
}
const ITEMS = [makeItem(1), makeItem(2), makeItem(3)];

let supa: SupabaseFake;

function live(): ChannelFake {
  const ch = supa.channelFor(TOPIC);
  if (!ch) throw new Error(`no channel opened for ${TOPIC}`);
  return ch;
}
const stateSends = () => live().sent.filter((s) => s.event === "state");

async function mountLive() {
  const view = render(
    <LiveMode
      eventId={EVENT_ID}
      groupId={GROUP_ID}
      eventName="Seishin Kakumei"
      items={ITEMS}
      songAudio={{}}
      canEdit={true}
      lastRunSeconds={null}
      lastRunAt={null}
    />
  );
  await act(async () => {});
  return view;
}

/** The snapshot of a show 2:00 into Track 1 (a 4:00 song), its page last alive `savedAgo` ago. */
function seedRunning(savedAgo: number, mode: "auto" | "manual") {
  const savedAt = Date.now() - savedAgo;
  const state = {
    running: true,
    begun: true,
    startedAt: savedAt - 600_000,
    itemStartedAt: savedAt - 120_000,
    itemElapsedAtPause: null,
    currentIndex: 0,
    mode,
  };
  localStorage.setItem(
    SNAPSHOT_KEY,
    JSON.stringify({
      state,
      currentItemId: "item-1",
      committed: { id: "item-1", anchor: savedAt - 120_000 },
      isController: true,
      controllerSince: savedAt - 600_000,
      savedAt,
    })
  );
  return state;
}

const disk = () => JSON.parse(localStorage.getItem(SNAPSHOT_KEY)!);
const plays = (media: MediaInstrumentation) => media.calls.filter((c) => c.type === "play").length;
const lastSeek = (media: MediaInstrumentation) =>
  media.calls.filter((c) => c.type === "currentTime").at(-1)?.value as number | undefined;
const lastSrc = (media: MediaInstrumentation) =>
  media.calls.filter((c) => c.type === "src").at(-1)?.value as string | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-08T17:50:00+07:00"));
  toast.message.mockClear();
  supa = makeSupabaseFake({
    session: makeSession(),
    script: { setlist_items: ok(ITEMS), songs: ok([]), show_authority: ok([]) },
  });
  h.supa = supa;
  h.saved = [
    { itemId: "item-1", blob: new Blob(["a1"]), name: "one.wav", path: null },
    { itemId: "item-2", blob: new Blob(["a2"]), name: "two.wav", path: null },
  ];
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("LiveMode · back three minutes after a crash mid-song", () => {
  for (const mode of ["auto", "manual"] as const) {
    it(`${mode}: paused on the song that was cut, at 2:00, and play goes on from there`, async () => {
      const media = instrumentMediaElements();
      const before = seedRunning(180_000, mode);
      await mountLive();
      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      // the same row, stopped where it stood - nothing sounds, nothing to tap
      expect(disk().currentItemId).toBe("item-1");
      expect(disk().state.running).toBe(false);
      expect(disk().state.itemElapsedAtPause).toBe(120);
      expect(screen.getByTestId("run-toggle").textContent).not.toContain("Pause");
      expect(screen.queryByText(/แตะเพื่อเล่นเสียงต่อ/)).toBeNull();
      expect(plays(media)).toBe(0);
      // the show clock is real time: the slot did go by (Hard Out, the run total)
      expect(disk().state.startedAt).toBe(before.startedAt);
      expect(toast.message).toHaveBeenCalledWith(
        "กู้คืนโชว์ — หยุดรอไว้ที่เพลงที่ค้าง",
        expect.objectContaining({ description: expect.stringContaining("ประมาณ 3 นาที") })
      );

      // Auto does not move on by itself while it waits, however long
      await act(async () => {
        vi.advanceTimersByTime(10 * 60 * 1000);
      });
      expect(disk().currentItemId).toBe("item-1");
      expect(plays(media)).toBe(0);

      await act(async () => {
        fireEvent.click(screen.getByTestId("run-toggle"));
      });
      expect(plays(media)).toBeGreaterThan(0);
      expect(lastSrc(media)).toMatch(/^blob:/); // the row's own file, loaded at its paused position
      expect(lastSeek(media)).toBe(120);
      await act(async () => {
        vi.advanceTimersByTime(1_000); // the snapshot's debounce
      });
      expect(disk().currentItemId).toBe("item-1");
      expect(disk().state.running).toBe(true);
    });
  }

  it("it is still the show: it keeps MAIN, and the viewers hear it paused", async () => {
    seedRunning(180_000, "auto");
    await mountLive();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    const sent = stateSends().at(-1)!.payload;
    expect(sent.begun).toBe(true);
    expect(sent.running).toBe(false);
    expect(sent.currentIndex).toBe(0);
    expect(sent.held).toBeUndefined();
    expect(supa.callsTo("show_authority", "upsert").length).toBeGreaterThan(0);
  });
});

describe("LiveMode · the restore's bands stay where they were", () => {
  it("back in 20 s (a reload): the show carries on by its clock", async () => {
    seedRunning(20_000, "auto");
    await mountLive();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId("run-toggle").textContent).toContain("Pause");
    expect(screen.getByText(/แตะเพื่อเล่นเสียงต่อ/)).toBeTruthy();
    expect(disk().state.running).toBe(true);
    expect(toast.message).toHaveBeenCalledWith("กู้คืนสถานะโชว์ที่ค้างไว้", expect.anything());
  });

  it("back in 11 min: held, as before", async () => {
    seedRunning(11 * 60 * 1000, "auto");
    await mountLive();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(disk().state.running).toBe(false);
    expect(disk().held).toBe(true);
    expect(toast.message).toHaveBeenCalledWith("กู้คืนโชว์ที่ค้างไว้ — หยุดรอไว้ก่อน", expect.anything());
  });
});
