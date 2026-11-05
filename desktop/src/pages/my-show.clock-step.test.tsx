// Quick Show's half of Live Mode's clock fixes (2026-11-05, hunt 13; see
// components/event/live-mode.clock-step.test.tsx). What used to go wrong:
// · A song that ENDED inside a JS freeze (the audio thread plays on through one) was taken for a
//   silent row: its clock was pushed back by the whole freeze and AUTO sat silent for as long
//   again as the song had had left.
// · The wall clock set BACK under a running show (Windows' time sync) was never seen: the row ran
//   long by the step - dead air at the end of a song in AUTO - and the show's total lost it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { instrumentMediaElements, type MediaInstrumentation } from "@/test/fakes/supabase";
import type { SoloItem } from "~/lib/solo-store";

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  message: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));
const store = vi.hoisted(() => ({ items: [] as SoloItem[], lastRuns: [] as unknown[] }));
vi.mock("~/lib/solo-store", () => ({
  listSoloItems: vi.fn(async () => store.items.map((it) => ({ ...it }))),
  putSoloItem: vi.fn(async () => {}),
  putSoloItems: vi.fn(async () => {}),
  deleteSoloItem: vi.fn(async () => {}),
  getSoloLastRun: vi.fn(async () => null),
  setSoloLastRun: vi.fn(async (rec: unknown) => void store.lastRuns.push(rec)),
  soloStorageBytes: vi.fn(async () => 0),
}));

import { MyShow } from "./my-show";

const song = (n: number, over: Partial<SoloItem> = {}): SoloItem =>
  ({
    id: `id-${n}`,
    kind: "song",
    title: `Song ${n}`,
    fileName: `s${n}.mp3`,
    blob: new Blob([new ArrayBuffer(16)], { type: "audio/mpeg" }),
    durationSeconds: 240,
    timingSeconds: 0,
    loop: false,
    volume: 100,
    sortOrder: n,
    ...over,
  }) as SoloItem;

let media: MediaInstrumentation;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
const tick = async (ms: number) => {
  for (let t = 0; t < ms; t += 250) await act(async () => void vi.advanceTimersByTime(250));
};
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const onNow = () => screen.getByRole("heading", { level: 2 }).textContent;
const gapToasts = () => toast.warning.mock.calls.filter((c) => String(c[0]).includes("เครื่องหยุดไป"));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-08T17:30:00+07:00"));
  for (const f of Object.values(toast)) f.mockClear();
  store.items = [song(1), song(2)];
  store.lastRuns = [];
  URL.createObjectURL = (() => `blob:q/${Math.random()}`) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  media = instrumentMediaElements({ autoRestore: false });
  localStorage.clear();
});
afterEach(() => {
  media.restore();
  vi.useRealTimers();
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

async function startAuto() {
  render(
    <MemoryRouter>
      <MyShow />
    </MemoryRouter>
  );
  await settle();
  await settle();
  await act(async () => void fireEvent.click(screen.getByRole("button", { name: /^Auto$/i })));
  await act(async () => void fireEvent.click(screen.getByTestId("start-show")));
}
/** The song plays on its own (sound card) clock: one second of file per second of real time. */
function player(el: HTMLMediaElement, duration: number) {
  let at = 0;
  media.set(el, { duration });
  return async (ms: number) => {
    for (let t = 0; t < ms; t += 250) {
      at = Math.min(duration, at + 0.25);
      media.set(el, { currentTime: at });
      await act(async () => void vi.advanceTimersByTime(250));
    }
  };
}

describe("Quick Show · a song that ends inside a JS freeze", () => {
  async function freezeOverTheEnd(ms: number) {
    await startAuto();
    const el = media.first()!;
    await tick(230_000);
    media.set(el, { duration: 240.4, currentTime: 230 });
    await tick(500); // a tick has seen the file at 3:50
    vi.setSystemTime(Date.now() + ms);
    media.set(el, { currentTime: 240.4, ended: true });
    await tick(1_000);
  }

  it("counts as played: a freeze that ends with the song moves nothing, says nothing, and AUTO moves on at once", async () => {
    await freezeOverTheEnd(10_500);
    expect(onNow()).toBe("Song 2"); // used to: 10 s more of silence on Song 1
    expect(gapToasts()).toHaveLength(0);
  }, 30_000);

  it("a freeze that outlasts the song: AUTO still moves on at once", async () => {
    await freezeOverTheEnd(13_000);
    expect(onNow()).toBe("Song 2");
  }, 30_000);
});

describe("Quick Show · the wall clock set BACK under a running show (a time sync)", () => {
  it("AUTO takes the next song when the song ends, not the step later, and says nothing", async () => {
    await startAuto();
    const play = player(media.first()!, 240);
    await play(100_000);
    vi.setSystemTime(Date.now() - 5_000);
    await play(140_500); // real time 4:00.5: the file is at its end
    expect(onNow()).toBe("Song 2"); // used to: 5 s of dead air first
    expect(toast.warning).not.toHaveBeenCalled();
  }, 30_000);

  it("the show's total does not lose the step", async () => {
    await startAuto();
    const play = player(media.first()!, 240);
    await play(90_000);
    vi.setSystemTime(Date.now() - 5_000);
    await play(1_000);
    await act(async () => void fireEvent.click(screen.getByTestId("end-show")));
    await settle();
    expect(store.lastRuns).toHaveLength(1);
    expect((store.lastRuns[0] as { seconds: number }).seconds).toBeGreaterThanOrEqual(90); // used to: 86
  }, 30_000);

  // Argon on hunt 13: START pressed between the step and the next tick is already on the new
  // clock - it was pushed forward by the whole step and AUTO cut Song 1 30 s early.
  it("START pressed just after the step, before the next tick: Song 1 plays to its end", async () => {
    render(
      <MemoryRouter>
        <MyShow />
      </MemoryRouter>
    );
    await settle();
    await settle();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /^Auto$/i })));
    await act(async () => void vi.advanceTimersByTime(500)); // a tick: nothing begun yet
    vi.setSystemTime(Date.now() - 30_000); // the time sync, 100 ms before START
    await act(async () => void vi.advanceTimersByTime(100));
    await act(async () => void fireEvent.click(screen.getByTestId("start-show")));
    const play = player(media.first()!, 240);
    await play(230_000);
    expect(onNow()).toBe("Song 1"); // used to: Song 2 with 30 s of Song 1 left
    await play(11_000);
    expect(onNow()).toBe("Song 2");
    expect(toast.warning).not.toHaveBeenCalled();
  }, 60_000);
});
