// QUICK SHOW — the cue keys after the operator has used a slider (2026-10-26 final
// hunt; ported from desktop/src/_probe/desktop/quick-show-slider-keys.test.tsx).
//
// The key handler bailed on ANY focused <input>, meant for typing in a field. But the
// per-track volume and the scrubber are <input type="range">, and Chromium FOCUSES a
// range input on a mouse drag (measured on Electron 45): drag the slider, then Space
// and → did nothing (→ moved the slider instead) until someone clicked elsewhere.
// Trim the sounding song by mouse, then cue the next one — dead air in Manual.
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
const running = () => screen.getByTestId("run-toggle").textContent?.includes("กำลังรัน");

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

/** The operator pulls Opening down a touch with the mouse — Chromium leaves the focus
 *  on the range input. */
async function dragVolume(): Promise<HTMLInputElement> {
  const volume = screen.getByTitle("ความดังของแทร็คนี้ (จำค่าไว้ให้)") as HTMLInputElement;
  await act(async () => {
    volume.focus();
    fireEvent.change(volume, { target: { value: "85" } });
  });
  expect(document.activeElement).toBe(volume);
  return volume;
}

describe("Quick Show — cue keys after the operator has used a slider", () => {
  it("→ still cues the next song while the sounding song's volume slider holds focus", async () => {
    await startShow();
    const volume = await dragVolume();

    let notPrevented = true;
    await act(async () => {
      notPrevented = fireEvent.keyDown(volume, { key: "ArrowRight", code: "ArrowRight" });
    });

    expect(positionLabel()).toBe("2 / 2");
    // the browser's own default (volume 85 → 86) was suppressed
    expect(notPrevented).toBe(false);
  });

  it("Space still pauses and resumes the show from a focused slider", async () => {
    await startShow();
    const before = running();
    const volume = await dragVolume();

    await act(async () => {
      fireEvent.keyDown(volume, { key: " ", code: "Space" });
    });
    expect(running()).toBe(!before);

    await act(async () => {
      fireEvent.keyDown(volume, { key: " ", code: "Space" });
    });
    expect(running()).toBe(before);
  });

  it("→ on a slider at the last cue neither cues nor moves the slider", async () => {
    await startShow();
    const volume = await dragVolume();
    await act(async () => {
      fireEvent.keyDown(volume, { key: "ArrowRight", code: "ArrowRight" });
    });
    expect(positionLabel()).toBe("2 / 2");

    let notPrevented = true;
    await act(async () => {
      notPrevented = fireEvent.keyDown(volume, { key: "ArrowRight", code: "ArrowRight" });
    });
    expect(positionLabel()).toBe("2 / 2");
    expect(notPrevented).toBe(false);
  });

  it("(control) typing in a text field is still ignored by the show keys", async () => {
    await startShow();
    const before = running();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /แก้ไข/ }));
    });
    const title = screen.getAllByPlaceholderText("ชื่อรายการ")[0] as HTMLInputElement;
    await act(async () => {
      title.focus();
    });
    expect(document.activeElement).toBe(title);

    let spaceNotPrevented = false;
    let arrowNotPrevented = false;
    await act(async () => {
      spaceNotPrevented = fireEvent.keyDown(title, { key: " ", code: "Space" });
      arrowNotPrevented = fireEvent.keyDown(title, { key: "ArrowRight", code: "ArrowRight" });
      fireEvent.keyDown(title, { key: "n", code: "KeyN" });
    });

    expect(positionLabel()).toBe("1 / 2");
    expect(running()).toBe(before);
    // the text field keeps its own keys (a space in a title, the caret moving)
    expect(spaceNotPrevented).toBe(true);
    expect(arrowNotPrevented).toBe(true);
  });

  it("(control) the same → with nothing focused cues the next song", async () => {
    await startShow();
    (document.activeElement as HTMLElement | null)?.blur?.();
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "ArrowRight", code: "ArrowRight" });
    });
    expect(positionLabel()).toBe("2 / 2");
  });
});
