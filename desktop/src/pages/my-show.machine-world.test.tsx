// Quick Show's half of Live Mode's machine-world fixes (2026-10-30, hunt 12; see
// components/event/live-mode.machine-world.test.tsx): the lid closed under a running show, and the
// sounding element dead with a media error (the USB interface pulled).
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
const store = vi.hoisted(() => ({ items: [] as SoloItem[] }));
vi.mock("~/lib/solo-store", () => ({
  listSoloItems: vi.fn(async () => store.items.map((it) => ({ ...it }))),
  putSoloItem: vi.fn(async () => {}),
  putSoloItems: vi.fn(async () => {}),
  deleteSoloItem: vi.fn(async () => {}),
  getSoloLastRun: vi.fn(async () => null),
  setSoloLastRun: vi.fn(async () => {}),
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
const sleep = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  for (const f of Object.values(toast)) f.mockClear();
  store.items = [song(1), song(2)];
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

async function startShow(auto: boolean) {
  render(
    <MemoryRouter>
      <MyShow />
    </MemoryRouter>
  );
  await settle();
  await settle();
  if (auto) await act(async () => void fireEvent.click(screen.getByRole("button", { name: /^Auto$/i })));
  await act(async () => void fireEvent.click(screen.getByTestId("start-show")));
}

describe("Quick Show · the machine slept under a running show", () => {
  it("a 30 s sleep: the song keeps its last 30 s", async () => {
    await startShow(true);
    const el = media.first()!;
    await tick(60_000);
    media.set(el, { currentTime: 60, duration: 240 });
    sleep(30_000);
    await tick(1_000);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    await tick(148_000);
    media.set(el, { currentTime: 210 });
    await tick(1_000);
    expect(onNow()).toBe("Song 1"); // used to: gone, 30 s before its end
  }, 30_000);

  it("a 5 min sleep: the next song does not start by itself", async () => {
    await startShow(true);
    const el = media.first()!;
    await tick(60_000);
    media.set(el, { currentTime: 60, duration: 240 });
    sleep(300_000);
    await tick(1_000);
    expect(onNow()).toBe("Song 1");
  }, 30_000);

  it("a paused show is left alone", async () => {
    await startShow(false);
    await tick(10_000);
    await act(async () => void fireEvent.click(screen.getByTestId("run-toggle")));
    sleep(60_000);
    await tick(1_000);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe("Quick Show · the sounding element died with a media error", () => {
  const RENDERER = { code: 3, message: "AUDIO_RENDERER_ERROR: audio error during playing" } as MediaError;
  async function dead() {
    await startShow(false);
    const el = media.first()!;
    await act(async () => media.emit(el, "playing"));
    await tick(95_000);
    media.set(el, { currentTime: 95, duration: 240, error: RENDERER });
    await act(async () => media.emit(el, "error"));
    return el;
  }
  const loads = (el: HTMLMediaElement) => media.callsFor(el).filter((c) => c.type === "src").length;

  it("brings up the rescue, which loads the file again at the show's position; it says the device went", async () => {
    const el = await dead();
    expect(toast.error.mock.calls[0][0]).toContain("เสียงหลุด");
    const before = loads(el);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /แตะเพื่อเล่นเสียงต่อ/ })));
    expect(loads(el)).toBeGreaterThan(before);
    expect(media.state(el).currentTime).toBeCloseTo(95, 0);
  }, 30_000);

  it("PAUSE then RUN loads the file again", async () => {
    const el = await dead();
    const before = loads(el);
    await act(async () => void fireEvent.click(screen.getByTestId("run-toggle")));
    await tick(500);
    await act(async () => void fireEvent.click(screen.getByTestId("run-toggle")));
    expect(loads(el)).toBeGreaterThan(before);
    expect(media.state(el).currentTime).toBeCloseTo(95, 0);
  }, 30_000);
});
