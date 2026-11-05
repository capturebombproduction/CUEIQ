// Quick Show back minutes after it died mid-song (2026-11-05, hunt 13) - the port of
// components/event/live-mode.crash-restore.test.tsx. The snapshot came back RUNNING with the
// row's clock run on through the outage: in Auto the song that was cut was over by its clock
// and the next one started by itself; in Manual RUN played the file from the wall clock. A
// page gone longer than RESUME_RUNNING_MS (lib/live-restore.ts) now comes back paused on its
// row, where it stood when last alive, and RUN plays on from there.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { instrumentMediaElements, type MediaInstrumentation } from "@/test/fakes/supabase";
import type { SoloItem, SoloLastRun } from "~/lib/solo-store";

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  message: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

const store = vi.hoisted(() => ({
  items: [] as SoloItem[],
  lastRun: null as SoloLastRun | null,
}));
vi.mock("~/lib/solo-store", () => ({
  listSoloItems: vi.fn(async () => store.items.map((it) => ({ ...it }))),
  putSoloItem: vi.fn(async () => {}),
  putSoloItems: vi.fn(async () => {}),
  deleteSoloItem: vi.fn(async () => {}),
  getSoloLastRun: vi.fn(async () => store.lastRun),
  setSoloLastRun: vi.fn(async (rec: SoloLastRun | null) => {
    store.lastRun = rec;
  }),
  soloStorageBytes: vi.fn(async () => 0),
}));

import { MyShow } from "./my-show";

const SNAPSHOT_KEY = "cueiq:solo:live";
const realSetTimeout = globalThis.setTimeout;
const macrotask = () => new Promise<void>((r) => realSetTimeout(r, 0));

function song(title: string, sortOrder: number): SoloItem {
  const buf = new ArrayBuffer(64);
  new Uint8Array(buf)[0] = sortOrder;
  return {
    id: `id-${title}`,
    kind: "song",
    title,
    fileName: `${title}.mp3`,
    blob: new Blob([buf], { type: "audio/mpeg" }),
    durationSeconds: 240,
    timingSeconds: 0,
    loop: false,
    volume: 100,
    sortOrder,
  };
}

let media: MediaInstrumentation;
let objectUrls: Map<Blob, string>;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  store.items = [];
  store.lastRun = null;
  toast.message.mockClear();
  objectUrls = new Map();
  let n = 0;
  URL.createObjectURL = ((obj: Blob) => {
    const url = `blob:quick-show/${++n}`;
    objectUrls.set(obj, url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  media = instrumentMediaElements({ autoRestore: false });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-08T17:50:00+07:00"));
});

afterEach(() => {
  vi.useRealTimers();
  media.restore();
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  window.localStorage.clear();
});

async function boot(items: SoloItem[]) {
  store.items = items;
  render(
    <MemoryRouter>
      <MyShow />
    </MemoryRouter>
  );
  await act(async () => {
    for (let i = 0; i < 4; i++) await macrotask();
  });
}
async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}
const heading = () => screen.getByRole("heading", { level: 2 });
const countdown = () => heading().nextElementSibling?.textContent;
const positionLabel = () => heading().previousElementSibling?.lastElementChild?.textContent;
const disk = () => JSON.parse(window.localStorage.getItem(SNAPSHOT_KEY) as string);
const plays = () => media.calls.filter((c) => c.type === "play").length;

/** 2:00 into the first song (4:00), its page last alive `savedAgo` ago. */
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
  window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ state, ended: false, savedAt }));
  return state;
}

const items = () => [song("One", 1), song("Two", 2), song("Three", 3)];

describe("Quick Show · back three minutes after a crash mid-song", () => {
  for (const mode of ["auto", "manual"] as const) {
    it(`${mode}: paused on the song that was cut, at 2:00, and RUN plays on from there`, async () => {
      const list = items();
      const before = seedRunning(180_000, mode);
      await boot(list);
      expect(positionLabel()).toBe("1 / 3");
      expect(heading()).toHaveTextContent("One");
      const frozen = countdown();
      expect(frozen).toBe("2:00");
      await tick(10 * 60 * 1000); // Auto does not move on by itself while it waits
      expect(positionLabel()).toBe("1 / 3");
      expect(countdown()).toBe(frozen);
      expect(plays()).toBe(0);
      expect(disk().state.running).toBe(false);
      expect(disk().state.itemElapsedAtPause).toBe(120);
      expect(disk().state.startedAt).toBe(before.startedAt); // the show clock is real time
      expect(toast.message).toHaveBeenCalledWith(
        "กู้คืนโชว์ — หยุดรอไว้ที่เพลงที่ค้าง",
        expect.objectContaining({ description: expect.stringContaining("ประมาณ 3 นาที") })
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId("run-toggle"));
      });
      expect(plays()).toBeGreaterThan(0);
      const srcs = media.calls.filter((c) => c.type === "src").map((c) => c.value);
      expect(srcs[srcs.length - 1]).toBe(objectUrls.get(list[0].blob as Blob));
      const seeks = media.calls.filter((c) => c.type === "currentTime");
      expect(seeks[seeks.length - 1]?.value).toBe(120);
      expect(positionLabel()).toBe("1 / 3");
    });
  }

  it("back in 20 s (a reload): the clock carries on running", async () => {
    seedRunning(20_000, "auto");
    await boot(items());
    const before = countdown();
    await tick(5_000);
    expect(countdown()).not.toBe(before);
    expect(toast.message).toHaveBeenCalledWith("กู้คืนสถานะโชว์ที่ค้างไว้", expect.anything());
  });

  it("back in 11 min: paused, with the stale show's words, as before", async () => {
    seedRunning(11 * 60 * 1000, "auto");
    await boot(items());
    const frozen = countdown();
    await tick(5_000);
    expect(countdown()).toBe(frozen);
    expect(toast.message).toHaveBeenCalledWith("กู้คืนโชว์ที่ค้างไว้ — หยุดรอไว้ก่อน", expect.anything());
  });
});
