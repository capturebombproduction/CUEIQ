// 2026-10-30, hunt 12: the show changes under a running Live.
// · A row deleted elsewhere while it sounds here (the phone's lock cannot know, with the PA off
//   the Wi-Fi): the next row slid under the running clock, NOW showed a song the PA was not
//   playing, and Auto moved on from it at that clock's end - that song never played.
// · A Hard Out cut on a phone reached an open Live only by a reload.
// · A row added while the last row ran past its slot made Auto cut it on the spot.
// · A real empty list (the event deleted) took every control away while the sound played on.
// · A crash reload came back by row NUMBER, on another row if one was added above meanwhile.
// · A lost "setlist-changed" left a visible PA on the old list for good; it looks once a minute.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import {
  makeSupabaseFake,
  instrumentMediaElements,
  makeSession,
  ok,
  fail,
  type SupabaseFake,
  type ChannelFake,
  type MediaInstrumentation,
} from "@/test/fakes/supabase";
import { liveTopic } from "@/lib/realtime";
import type { SetlistItem } from "@/lib/types";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  saved: [] as Array<{ itemId: string; blob: Blob; name: string; path: string | null }>,
  toastWarning: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => h.saved),
  deleteAudio: vi.fn(async () => {}),
}));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  downloadEventAudio: vi.fn(() => new Promise<Blob>(() => {})),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    warning: h.toastWarning,
  }),
  Toaster: () => null,
}));

import { LiveMode } from "@/components/event/live-mode";
import { downloadEventAudio } from "@/lib/audio-remote";

const EVENT_ID = "11111111-2222-4333-8444-555555555555";
const GROUP_ID = "66666666-7777-4888-8999-000000000000";

function makeItem(n: number, over: Partial<SetlistItem> = {}): SetlistItem {
  return {
    id: `item-${n}`,
    tenant_id: "tenant-1",
    event_id: EVENT_ID,
    kind: "song",
    title: `Track ${n}`,
    duration_seconds: 200,
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
let server: SetlistItem[];
let eventsAnswer: unknown;
let media: MediaInstrumentation;
const live = (): ChannelFake => supa.channelFor(liveTopic(EVENT_ID))!;
const lastState = () =>
  [...live().sent].reverse().find((s) => s.event === "state")?.payload as {
    currentItemId?: string;
    running?: boolean;
    itemElapsedAtPause?: number | null;
  };
const liveIndex = () => document.querySelector("[data-cueiq-live-index]")?.getAttribute("data-cueiq-live-index");
const flush = async () => {
  for (let i = 0; i < 8; i++) await act(async () => {});
};
const tick = async (ms: number) => {
  for (let t = 0; t < ms; t += 500) {
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
  }
};
const sounding = (id: string) =>
  media.elements.filter((el) => media.state(el).src === `blob:${id}` && !media.state(el).paused);
const withFiles = (rows: SetlistItem[]) => {
  h.saved = rows.map((it) => ({
    itemId: it.id,
    blob: Object.assign(new Blob([it.id]), { row: it.id }),
    name: `${it.id}.wav`,
    path: null,
  }));
};
const otherDeviceSaved = async () => {
  await act(async () => {
    live().emit("setlist-changed", {});
  });
  await flush();
};

function mount(rows: SetlistItem[], extra: Record<string, unknown> = {}) {
  return render(
    <LiveMode eventId={EVENT_ID} groupId={GROUP_ID} eventName="Show" items={rows} songAudio={{}}
      canEdit lastRunSeconds={null} lastRunAt={null} {...extra} />
  );
}
async function start(rows: SetlistItem[], extra: Record<string, unknown> = {}) {
  mount(rows, extra);
  await flush();
  await act(async () => live().setStatus("SUBSCRIBED"));
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  await flush();
  await act(async () => {
    fireEvent.click(screen.getByTestId("start-show"));
  });
  await flush();
  await tick(3_000); // past START's double-tap guard
}
const toAuto = async () => {
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Auto" })[0]);
  });
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    (b: Blob | MediaSource) => `blob:${(b as Blob & { row?: string }).row ?? "?"}`
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  h.toastWarning.mockClear();
  h.saved = [];
  server = [makeItem(1), makeItem(2), makeItem(3)];
  eventsAnswer = null;
  media = instrumentMediaElements();
  supa = makeSupabaseFake({
    session: makeSession(),
    script: {
      setlist_items: () => ok(server),
      songs: ok([]),
      show_authority: ok([]),
      events: () => (eventsAnswer ?? ok(null)) as never,
    },
  });
  h.supa = supa;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.useRealTimers();
});

describe("LiveMode · the row on air is deleted elsewhere", () => {
  it("Auto: it plays on, the next row gets its own full slot, and the operator is told", async () => {
    withFiles(server);
    await start(server);
    await toAuto();
    await tick(100_000);
    expect(sounding("item-1")).toHaveLength(1);
    server = [makeItem(2), makeItem(3)];
    await otherDeviceSaved();
    expect(sounding("item-1")).toHaveLength(1); // the sound is untouched
    expect(h.toastWarning).toHaveBeenCalledTimes(1);
    expect(liveIndex()).toBe("0");
    await tick(110_000); // item-1's own 200 s are over: item-2's turn, from its top
    expect(lastState().currentItemId).toBe("item-2");
    expect(sounding("item-2")).toHaveLength(1);
    expect(sounding("item-1")).toHaveLength(0);
    await tick(150_000); // 150 s into item-2's 200: still its turn
    expect(lastState().currentItemId).toBe("item-2");
    await tick(60_000);
    expect(lastState().currentItemId).toBe("item-3");
  }, 30_000);

  it("the kept row leaves the list once the show has moved off it, and the cue stays on its row", async () => {
    withFiles(server);
    await start(server);
    await toAuto();
    server = [makeItem(2), makeItem(3)];
    await otherDeviceSaved();
    await tick(200_000);
    expect(lastState().currentItemId).toBe("item-2");
    expect(screen.queryByText("Track 1")).toBeNull();
    expect(liveIndex()).toBe("0"); // item-2, now the first row
  });

  it("says so once, however many re-reads land while it is kept", async () => {
    withFiles(server);
    await start(server);
    server = [makeItem(2), makeItem(3)];
    await otherDeviceSaved();
    await otherDeviceSaved();
    expect(h.toastWarning).toHaveBeenCalledTimes(1);
  });

  it("Manual: the sounding row under a cue on another row plays on too", async () => {
    withFiles(server);
    await start(server);
    await act(async () => {
      fireEvent.keyDown(window, { key: "n" });
    });
    await flush();
    expect(lastState().currentItemId).toBe("item-2");
    expect(sounding("item-1")).toHaveLength(1);
    server = [makeItem(2), makeItem(3)];
    await otherDeviceSaved();
    expect(sounding("item-1")).toHaveLength(1);
    expect(lastState().currentItemId).toBe("item-2");
  });
});

describe("LiveMode · the row the show stands on is deleted and nothing of it sounds", () => {
  it("the next row waits as a frozen cue, told to every device", async () => {
    await start(server); // no files: a talk, say
    await tick(100_000);
    server = [makeItem(2), makeItem(3)];
    await otherDeviceSaved();
    const s = lastState();
    expect(s.currentItemId).toBe("item-2");
    expect(s.running).toBe(false);
    expect(s.itemElapsedAtPause).toBe(0);
    expect(liveIndex()).toBe("0");
    expect(h.toastWarning).toHaveBeenCalledTimes(1);
  });
});

describe("LiveMode · a viewer of a show whose on-air row is deleted", () => {
  const stateOf = (id: string, index: number, t: number) => ({
    sender: "pa", sentAt: t, fromController: true, begun: true, running: true,
    startedAt: t - 60_000, itemStartedAt: t - 10_000, itemElapsedAtPause: null,
    currentIndex: index, currentItemId: id, mode: "auto", controllerSince: t - 60_000, ended: false,
  });

  it("stays on the PA's row until the PA moves, then agrees on the next one", async () => {
    mount(server);
    await flush();
    await act(async () => live().emit("state", stateOf("item-1", 0, Date.now())));
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
    server = [makeItem(2), makeItem(3)];
    await otherDeviceSaved();
    expect(liveIndex()).toBe("0");
    expect(screen.getAllByText("Track 1").length).toBeGreaterThan(0);
    await act(async () => live().emit("state", stateOf("item-2", 1, Date.now())));
    await flush();
    await tick(500);
    expect(screen.queryByText("Track 1")).toBeNull();
    expect(liveIndex()).toBe("0"); // item-2 on this device's own list
  });
});

describe("LiveMode · the show's times changed on a phone", () => {
  const times = { eventDate: "2026-08-08", showStartTime: "20:00:00", hardOutTime: "23:00:00" };
  const gap = () => screen.getAllByTestId("hard-out-gap")[0].textContent;

  it("the Hard Out reading follows a re-read, and the audio never hears of it", async () => {
    withFiles(server);
    await start(server, times);
    const before = media.calls.length;
    const clock = lastState();
    expect(document.body.textContent).toContain("Hard Out 23:00");
    eventsAnswer = ok({ event_date: "2026-08-08", show_start_time: "20:00:00", hard_out_time: "20:05:00" });
    await otherDeviceSaved();
    expect(document.body.textContent).toContain("Hard Out 20:05");
    expect(gap()).toContain("เกิน");
    expect(media.calls.length).toBe(before);
    expect(lastState()).toEqual(clock);
  });

  it("a failed read keeps the old times", async () => {
    await start(server, times);
    eventsAnswer = fail("boom");
    await otherDeviceSaved();
    expect(document.body.textContent).toContain("Hard Out 23:00");
  });

  it("an empty read keeps the old times", async () => {
    await start(server, times);
    eventsAnswer = ok(null);
    await otherDeviceSaved();
    expect(document.body.textContent).toContain("Hard Out 23:00");
  });
});

describe("LiveMode · Auto on the last row", () => {
  it("run past its slot with nothing after it: a row added now does not cut it", async () => {
    server = [makeItem(1), makeItem(2, { duration_seconds: 10, kind: "mc", loop_audio: true })];
    withFiles(server);
    await start(server);
    await toAuto();
    await tick(240_000);
    expect(lastState().currentItemId).toBe("item-2");
    expect(sounding("item-2")).toHaveLength(1);
    server = [...server, makeItem(3, { duration_seconds: 0, title: "" })];
    await otherDeviceSaved();
    await tick(5_000);
    expect(lastState().currentItemId).toBe("item-2");
    expect(sounding("item-2")).toHaveLength(1);
  });

  it("a row added BEFORE it ran out: it moves on at the end of its slot, as ever", async () => {
    server = [makeItem(1, { duration_seconds: 20 })];
    withFiles(server);
    await start(server);
    await toAuto();
    server = [...server, makeItem(2)];
    await otherDeviceSaved();
    await tick(25_000);
    expect(lastState().currentItemId).toBe("item-2");
  });

  it("a row with a next row moves on, whatever the last row did before", async () => {
    server = [makeItem(1, { duration_seconds: 5 }), makeItem(2, { duration_seconds: 5 }), makeItem(3)];
    await start(server);
    await toAuto();
    await tick(15_000);
    expect(lastState().currentItemId).toBe("item-3");
  });
});

describe("LiveMode · the list reads empty under a show that has begun", () => {
  it("keeps the list and every control, with the sound on, and says why", async () => {
    withFiles(server);
    await start(server);
    server = [];
    await otherDeviceSaved();
    expect(screen.queryByText(/ยังไม่มีรายการในเซ็ตลิสต์/)).toBeNull();
    expect(sounding("item-1")).toHaveLength(1);
    expect(screen.getAllByText("Track 1").length).toBeGreaterThan(0);
    expect(h.toastWarning).toHaveBeenCalledWith(
      expect.stringContaining("ว่าง"),
      expect.objectContaining({ id: "live-list-empty" })
    );
  });

  it("before the show it is simply empty, as before", async () => {
    mount(server);
    await flush();
    server = [];
    await otherDeviceSaved();
    expect(screen.getByText(/ยังไม่มีรายการในเซ็ตลิสต์/)).toBeInTheDocument();
  });
});

describe("LiveMode · a crash reload", () => {
  const snapshot = (over: Record<string, unknown>) => {
    const t = Date.now();
    localStorage.setItem(
      `cueiq:live:${EVENT_ID}`,
      JSON.stringify({
        state: {
          running: true, begun: true, startedAt: t - 60_000, itemStartedAt: t - 30_000,
          itemElapsedAtPause: null, currentIndex: 1, mode: "auto",
        },
        committed: { id: "item-2", anchor: t - 30_000 },
        controllerSince: t - 60_000,
        savedAt: t - 5_000,
        ...over,
      })
    );
  };

  it("comes back on the row it stood on when one was added above it meanwhile", async () => {
    snapshot({ currentItemId: "item-2" });
    server = [makeItem(9, { sort_order: 0 }), makeItem(1), makeItem(2), makeItem(3)];
    mount(server);
    await flush();
    expect(liveIndex()).toBe("2");
  });

  it("that row gone, or an older snapshot: the number, in range", async () => {
    snapshot({ currentItemId: "item-gone" });
    server = [makeItem(1)];
    mount(server);
    await flush();
    expect(liveIndex()).toBe("0");
    cleanup();
    localStorage.clear();
    snapshot({});
    server = [makeItem(1), makeItem(2), makeItem(3)];
    mount(server);
    await flush();
    expect(liveIndex()).toBe("1");
  });

  it("the snapshot it writes names the row", async () => {
    await start(server);
    await tick(35_000);
    const snap = JSON.parse(localStorage.getItem(`cueiq:live:${EVENT_ID}`)!);
    expect(snap.currentItemId).toBe("item-1");
  });
});

describe("LiveMode · the once-a-minute look at the list", () => {
  const reads = () => supa.callsTo("setlist_items", "select").length;

  it("on an unchanged list it touches nothing: no audio call, no message, no file, no state", async () => {
    withFiles(server);
    await start(server);
    await toAuto();
    const readsBefore = reads();
    const callsBefore = media.calls.length;
    const urlsBefore = vi.mocked(URL.createObjectURL).mock.calls.length;
    const revokedBefore = vi.mocked(URL.revokeObjectURL).mock.calls.length;
    const sentBefore = live().sent.length;
    const el = sounding("item-1")[0];
    const at = media.state(el).currentTime;
    const idx = liveIndex();
    await tick(120_000); // 2 looks, still inside item-1's slot
    expect(reads()).toBeGreaterThanOrEqual(readsBefore + 2);
    expect(media.calls.length).toBe(callsBefore);
    expect(vi.mocked(URL.createObjectURL).mock.calls.length).toBe(urlsBefore);
    expect(vi.mocked(URL.revokeObjectURL).mock.calls.length).toBe(revokedBefore);
    expect(live().sent.filter((s) => s.event !== "state").length).toBe(
      live().sent.slice(0, sentBefore).filter((s) => s.event !== "state").length
    );
    expect(sounding("item-1")).toEqual([el]);
    expect(media.state(el).currentTime).toBe(at);
    expect(liveIndex()).toBe(idx);
    expect(h.toastWarning).not.toHaveBeenCalled();
  });

  it("a master still on its way is not asked for again", async () => {
    vi.mocked(downloadEventAudio).mockClear();
    server = [makeItem(1, { audio_path: "t/g/e/one.wav" }), makeItem(2)];
    mount(server);
    await flush();
    await tick(1_000);
    expect(downloadEventAudio).toHaveBeenCalledTimes(1);
    await tick(130_000);
    expect(downloadEventAudio).toHaveBeenCalledTimes(1);
  });

  it("a change whose broadcast was lost arrives within the minute, by id", async () => {
    await start(server);
    server = [makeItem(9, { sort_order: 0, title: "Added" }), ...server];
    await tick(61_000);
    expect(screen.getAllByText("Added").length).toBeGreaterThan(0);
    expect(liveIndex()).toBe("1"); // item-1, one row down
  });

  it("offline it does not look", async () => {
    await start(server);
    const before = reads();
    const on = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await tick(130_000);
    expect(reads()).toBe(before);
    on.mockRestore();
  });
});
