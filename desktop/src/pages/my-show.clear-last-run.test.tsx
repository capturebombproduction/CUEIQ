// 2026-10-30, hunt 10 (mistakes-4): Quick Show's "ล้าง" beside เวลาโชว์ล่าสุด cleared the saved run
// time on a single tap. The label's rule is a confirm before every delete; it now asks first, in
// the page's own window.confirm style (Reset's).
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
async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await macrotask();
  });
}

const song: SoloItem = {
  id: "id-Akai",
  kind: "song",
  title: "Akai",
  fileName: "Akai.mp3",
  blob: new Blob([new ArrayBuffer(16)], { type: "audio/mpeg" }),
  durationSeconds: 180,
  timingSeconds: 0,
  loop: false,
  volume: 100,
  sortOrder: 1,
} as SoloItem;

let media: MediaInstrumentation;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  store.items = [song];
  store.lastRun = { seconds: 754, at: Date.parse("2026-10-29T18:00:00+07:00") };
  store.lastRunWrites = [];
  URL.createObjectURL = (() => "blob:quick-show/1") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  media = instrumentMediaElements({ autoRestore: false });
});
afterEach(() => {
  vi.restoreAllMocks();
  media.restore();
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

async function boot() {
  render(
    <MemoryRouter>
      <MyShow />
    </MemoryRouter>
  );
  await settle();
}
const clearKey = () => screen.getByRole("button", { name: "ล้าง" });

describe("Quick Show · ล้าง เวลาโชว์ล่าสุด asks first", () => {
  it("answered no: the saved run time stays", async () => {
    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    await boot();
    expect(screen.getAllByText("12:34").length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(clearKey());
    });
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(store.lastRunWrites).toHaveLength(0);
    expect(screen.getAllByText("12:34").length).toBeGreaterThan(0);
  });

  it("answered yes: cleared as before", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await boot();
    await act(async () => {
      fireEvent.click(clearKey());
    });
    await settle();
    expect(store.lastRunWrites).toEqual([null]);
    expect(screen.queryByRole("button", { name: "ล้าง" })).toBeNull();
  });
});
