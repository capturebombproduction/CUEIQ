// Hunt 7 (2026-10-27, multi - one show, many devices). Three things a show night hit:
// · a viewer asleep or off Wi-Fi at the moment its run was RESET never heard that reset
//   again (it goes out once, and a device that is not running a show answers no
//   sync-request), so it stayed "ดูอย่างเดียว" - START gone, Reset disabled - until a reload.
//   The page that ran it saying "no show" now frees it the same way.
// · a file picked in Live linked its row with an unchecked write: a token that expired
//   during the upload answered with 0 rows, the pick said it was in the library, and every
//   other device kept the row's old master. And the approvers were never told the new
//   temporary song waits (a song added in the library tells them).
// · a file the player cannot open (.wma, an ALAC .m4a) went up as the row's master: silent
//   on every device. It is refused at the pick now, before anything is held or written.
// · a held Enter on a focused NEXT / RUN-PAUSE button clicked it again on every auto-repeat.
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

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-remote", async (orig) => ({
  ...(await orig<typeof import("@/lib/audio-remote")>()),
  downloadEventAudio: vi.fn(() => new Promise<Blob>(() => {})),
  uploadEventAudio: vi.fn(async () => {}),
}));
// jsdom's <audio> never answers: the pick's open check (audioOpenProblem) would wait out its 3 s
vi.mock("@/lib/audio", async (orig) => ({ ...(await orig<typeof import("@/lib/audio")>()), audioOpenProblem: vi.fn(async () => null) }));
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => []),
  deleteAudio: vi.fn(async () => {}),
}));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));

import { toast } from "sonner";
import { LiveMode } from "@/components/event/live-mode";
import { notify } from "@/lib/notify-client";
import { audioOpenProblem, UNOPENABLE_AUDIO_MESSAGE } from "@/lib/audio";

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
const ITEMS = [makeItem(1), makeItem(2), makeItem(3)];

let supa: SupabaseFake;
const live = (): ChannelFake => {
  const c = supa.channelFor(TOPIC);
  if (!c) throw new Error("no live channel");
  return c;
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await act(async () => {});
};

function mount(rows: SetlistItem[] = ITEMS) {
  return render(
    <LiveMode eventId={EVENT_ID} groupId={GROUP_ID} eventName="Show" items={rows} songAudio={{}}
      canEdit={true} lastRunSeconds={null} lastRunAt={null} />
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  vi.mocked(notify).mockClear();
  supa = makeSupabaseFake({
    session: makeSession(),
    script: { setlist_items: ok(ITEMS), songs: ok([]), show_authority: ok([]) },
  });
  h.supa = supa;
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.useRealTimers();
});

const pre = (sender: string, over: Record<string, unknown> = {}) => ({
  sender, sentAt: Date.now(), fromController: true, begun: false, running: false,
  startedAt: null, itemStartedAt: null, itemElapsedAtPause: null,
  currentIndex: 0, mode: "auto", controllerSince: null, ended: false, ...over,
});

async function mountViewerOf(sender: string) {
  mount();
  await act(async () => {});
  const t = Date.now();
  await act(async () => {
    live().emit("state", {
      sender, sentAt: t, fromController: true, begun: true, running: true,
      startedAt: t - 60_000, itemStartedAt: t - 10_000, itemElapsedAtPause: null,
      currentIndex: 0, mode: "manual", controllerSince: t - 60_000, ended: false,
    });
  });
  expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
}

describe("LiveMode · a viewer that missed its run's reset (hunt 7)", () => {
  it("is freed when the page that ran the show says there is none - the reset heard late", async () => {
    await mountViewerOf("tablet");
    // the reset went out while this laptop was off Wi-Fi; back, the tablet's next word
    // (a pre-show setting) carries no resetRun
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      window.dispatchEvent(new Event("online"));
    });
    await act(async () => {
      live().emit("state", pre("tablet"));
    });
    expect(screen.queryByTestId("viewer-banner")).not.toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(2_000); // it asks again first, as after a heard reset
    });
    expect(screen.getByTestId("start-show")).toBeEnabled();
  });

  it("another page with no show still frees nothing", async () => {
    await mountViewerOf("tablet");
    await act(async () => {
      live().emit("state", pre("phone-that-just-opened"));
    });
    expect(screen.getByTestId("viewer-banner")).toBeInTheDocument();
  });
});

describe("LiveMode · a file picked in Live links its row for real (hunt 7)", () => {
  async function pick(linkAnswer: (c: RecordedCall) => ReturnType<typeof ok>) {
    supa = makeSupabaseFake({
      session: makeSession(),
      script: {
        setlist_items: (c: RecordedCall) => (c.verb === "update" ? linkAnswer(c) : ok(ITEMS)),
        songs: (c: RecordedCall) =>
          c.verb === "insert" ? ok({ id: "song-new" }) : c.verb === "update" ? ok([{ id: "song-new" }]) : ok([]),
        show_authority: ok([]),
      },
    });
    h.supa = supa;
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:picked");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    instrumentMediaElements();
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    mount();
    await flush();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getAllByTitle("โหลดไฟล์เพลง (อัปโหลดขึ้นคลาวด์)")[0]);
    });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(["x"], "mine.wav", { type: "audio/wav" })] } });
    });
    await flush();
    const said = (spy: typeof success) => spy.mock.calls.map((c) => String(c[0]));
    return { success: said(success), error: said(error), errorCalls: error.mock.calls };
  }

  it("a link that wrote no row is a failure: the local-copy toast, not 'in the library'", async () => {
    const { success, error } = await pick(() => ok([]));
    expect(success.some((m) => m.startsWith("อัปขึ้นคลังเป็นเพลงชั่วคราว"))).toBe(false);
    expect(error).toContain("อัปโหลดออนไลน์ไม่สำเร็จ — ไฟล์ยังเล่นได้เฉพาะเครื่องนี้");
    expect(notify).not.toHaveBeenCalled();
  });

  it("a file the player cannot open is refused before anything is uploaded, linked or held", async () => {
    vi.mocked(audioOpenProblem).mockResolvedValueOnce(UNOPENABLE_AUDIO_MESSAGE);
    const { success, errorCalls } = await pick(() => ok([{ id: "item-1" }]));
    expect(errorCalls).toContainEqual(["ใช้ไฟล์นี้ไม่ได้", { description: UNOPENABLE_AUDIO_MESSAGE }]);
    expect(success).toEqual([]);
    const wrote = supa.calls.filter((c) => c.verb !== "select").map((c) => `${c.table}.${c.verb}`);
    expect(wrote.filter((w) => w.startsWith("songs.") || w.startsWith("setlist_items."))).toEqual([]);
    expect(URL.createObjectURL).not.toHaveBeenCalled(); // the row keeps what it had
  });

  it("a link that landed tells the approvers the temporary song waits", async () => {
    const { success } = await pick(() => ok([{ id: "item-1" }]));
    expect(success.some((m) => m.startsWith("อัปขึ้นคลังเป็นเพลงชั่วคราว"))).toBe(true);
    expect(notify).toHaveBeenCalledWith("song_pending", { songId: "song-new" });
  });
});

describe("LiveMode · a held Enter on a focused button is one press (hunt 7)", () => {
  function enter(target: HTMLElement, repeat: boolean) {
    const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, repeat });
    act(() => {
      target.dispatchEvent(ev);
    });
    return ev.defaultPrevented;
  }

  it("the repeats are suppressed, the first Enter is not", async () => {
    mount();
    await flush();
    await act(async () => {
      live().setStatus("SUBSCRIBED");
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("start-show"));
    });
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    const next = screen.getAllByTestId("next")[0];
    next.focus();
    expect(enter(next, false)).toBe(false);
    expect(enter(next, true)).toBe(true);
    expect(enter(next, true)).toBe(true);
  });
});
