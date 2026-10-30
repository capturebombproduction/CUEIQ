// 2026-10-30, hunt 12 (keys-1..4, fresh-1): Quick Show under the operator's fingers.
//  - N read e.key only: with the Thai layout on it gives "ื", so the key was dead (Live Mode has
//    read e.code too since 2026-10-25).
//  - Home / End / a page on a slider that kept the focus after a mouse drag took the level to 0 or
//    the song back to its top in one key (Chromium's default, measured on Electron 45).
//  - Space on a key of a question on screen paused the show and answered nothing.
//  - ล้าง's question: the focus fell to <body>, and a double-click on ล้าง landed on ล้างเลย.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { instrumentMediaElements, type MediaInstrumentation } from "@/test/fakes/supabase";
import type { SoloItem, SoloLastRun } from "~/lib/solo-store";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), message: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));
const store = vi.hoisted(() => ({
  items: [] as SoloItem[],
  lastRun: null as SoloLastRun | null,
  lastRunWrites: [] as (SoloLastRun | null)[],
}));
vi.mock("~/lib/solo-store", () => ({
  listSoloItems: vi.fn(async () => store.items.map((it) => ({ ...it }))),
  putSoloItem: vi.fn(async () => {}),
  putSoloItems: vi.fn(async () => {}),
  deleteSoloItem: vi.fn(async () => {}),
  getSoloLastRun: vi.fn(async () => store.lastRun),
  setSoloLastRun: vi.fn(async (rec: SoloLastRun | null) => {
    store.lastRun = rec;
    store.lastRunWrites.push(rec);
  }),
  soloStorageBytes: vi.fn(async () => 0),
}));
import { MyShow } from "./my-show";

const realSetTimeout = globalThis.setTimeout;
const macrotask = () => new Promise<void>((r) => realSetTimeout(r, 0));
const song = (title: string, sortOrder: number): SoloItem => ({
  id: `id-${title}`,
  kind: "song",
  title,
  fileName: `${title}.mp3`,
  blob: new Blob([new ArrayBuffer(64)], { type: "audio/mpeg" }),
  durationSeconds: 180,
  timingSeconds: 0,
  loop: false,
  volume: 100,
  sortOrder,
});
let media: MediaInstrumentation;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
beforeEach(() => {
  let n = 0;
  URL.createObjectURL = (() => `blob:quick-show/${++n}`) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  media = instrumentMediaElements({ autoRestore: false });
  store.items = [song("Opening", 1), song("Second", 2)];
  store.lastRun = { seconds: 754, at: Date.parse("2026-10-29T18:00:00+07:00") };
  store.lastRunWrites = [];
});
afterEach(() => {
  media.restore();
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});
const settle = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await macrotask();
  });
const position = () => screen.getByRole("heading", { level: 2 }).previousElementSibling?.lastElementChild?.textContent;
const running = () => screen.getByTestId("run-toggle").textContent?.includes("กำลังรัน");
async function boot() {
  render(
    <MemoryRouter>
      <MyShow />
    </MemoryRouter>
  );
  await settle();
}
async function startShow() {
  await boot();
  await act(async () => {
    fireEvent.click(screen.getByTestId("start-show"));
  });
}
async function press(key: string, code = key) {
  const target = (document.activeElement as HTMLElement) ?? document.body;
  const ev = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(ev);
  });
  return ev;
}
async function mouseClick(el: HTMLElement) {
  await act(async () => {
    el.focus();
    fireEvent.click(el);
  });
}
const key = (name: string) => screen.getByRole("button", { name });

describe("Quick Show · N with the Thai layout on", () => {
  it("N (e.key 'ื', e.code KeyN) cues the next row, as on the English layout", async () => {
    await startShow();
    expect(position()).toBe("1 / 2");
    await press("ื", "KeyN");
    expect(position()).toBe("2 / 2");
  });
});

describe("Quick Show · a slider that kept the focus", () => {
  it.each(["Home", "End", "PageUp", "PageDown"])("%s does not move it", async (k) => {
    await startShow();
    const slider = screen.getAllByRole("slider")[0];
    await act(async () => {
      slider.focus();
    });
    expect((await press(k)).defaultPrevented).toBe(true);
  });
  it("↑ still does", async () => {
    await startShow();
    const slider = screen.getAllByRole("slider")[0];
    await act(async () => {
      slider.focus();
    });
    expect((await press("ArrowUp")).defaultPrevented).toBe(false);
  });
});

describe("Quick Show · a question's keys are the question's", () => {
  it("Space on ไม่ล้าง mid-show answers it and leaves the show running", async () => {
    await startShow();
    const before = running();
    await mouseClick(key("ล้าง"));
    const ev = await press(" ", "Space");
    expect(ev.defaultPrevented).toBe(false); // Chromium's click comes on its keyup
    expect(running()).toBe(before);
  });
});

describe("Quick Show · ล้าง's question", () => {
  it("opens with the focus on ไม่ล้าง, which gives it back to ล้าง", async () => {
    await boot();
    await mouseClick(key("ล้าง"));
    expect(document.activeElement).toBe(key("ไม่ล้าง"));
    await mouseClick(key("ไม่ล้าง"));
    expect(document.activeElement).toBe(key("ล้าง"));
  });

  it("a double-click on ล้าง lands on the safe key and keeps the record", async () => {
    await boot();
    const clear = key("ล้าง");
    const row = clear.parentElement as HTMLElement;
    expect(row.lastElementChild).toBe(clear);
    await mouseClick(clear);
    const buttons = row.querySelectorAll("button");
    expect(Array.from(buttons).map((b) => b.textContent)).toEqual(["ล้างเลย", "ไม่ล้าง"]);
    await mouseClick(buttons[buttons.length - 1] as HTMLElement);
    expect(store.lastRunWrites).toHaveLength(0);
  });
});
