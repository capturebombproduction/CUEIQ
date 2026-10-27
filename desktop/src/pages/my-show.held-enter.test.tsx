// QUICK SHOW - a held Enter on a focused button is one press (2026-10-27, hunt 7). Chromium
// clicks a focused button again on every Enter auto-repeat, so a held Enter on NEXT walked
// the setlist and on RUN/PAUSE flipped the show ~30 times a second - what held Space did
// before its own guard. The first Enter still clicks; the repeats are suppressed.
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
  setSoloLastRun: vi.fn(async () => {}),
  soloStorageBytes: vi.fn(async () => 0),
}));

import { MyShow } from "./my-show";

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
    durationSeconds: 180,
    timingSeconds: 0,
    loop: false,
    volume: 100,
    sortOrder,
  };
}

let media: MediaInstrumentation;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = (() => `blob:quick-show/${++n}`) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  media = instrumentMediaElements({ autoRestore: false });
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(new Date("2026-10-26T20:00:00+07:00"));
  store.items = [song("Opening", 1), song("Second", 2)];
  store.lastRun = null;
});

afterEach(() => {
  vi.useRealTimers();
  media.restore();
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await macrotask();
  });
}

const positionLabel = () =>
  screen.getByRole("heading", { level: 2 }).previousElementSibling?.lastElementChild?.textContent;

/** START (Manual is the default mode): Opening sounds. */
async function startShow() {
  render(
    <MemoryRouter>
      <MyShow />
    </MemoryRouter>
  );
  await settle();
  await act(async () => {
    fireEvent.click(screen.getByTestId("start-show"));
  });
  expect(positionLabel()).toBe("1 / 2");
}

describe("Quick Show - a held Enter on a focused button", () => {
  it("suppresses the repeats, never the first Enter", async () => {
    await startShow();
    const btn = screen.getByTestId("run-toggle");
    btn.focus();
    const enter = (repeat: boolean) => {
      const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, repeat });
      act(() => {
        btn.dispatchEvent(ev);
      });
      return ev.defaultPrevented;
    };
    expect(enter(false)).toBe(false);
    expect(enter(true)).toBe(true);
    expect(enter(true)).toBe(true);
  });
});
