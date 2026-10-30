// 2026-10-30, hunt 10 (mistakes-4): Quick Show's "ล้าง" beside เวลาโชว์ล่าสุด cleared the saved run
// time on a single tap. The label's rule is a confirm before every delete; it now asks first.
// 2026-10-30, hunt 11: hunt 10 asked with window.confirm, and the key is there while the show runs -
// a modal stops the JS thread, so the Auto countdown and every fade waited on the answer. It asks in
// the record itself now, and window.confirm is never called.
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

describe("Quick Show · ล้าง เวลาโชว์ล่าสุด asks first, in place", () => {
  it("answered no: the saved run time stays", async () => {
    const modal = vi.spyOn(window, "confirm");
    await boot();
    expect(screen.getAllByText("12:34").length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(clearKey());
    });
    await settle();
    expect(screen.getByText("ล้างเวลานี้? ล้างแล้วกู้คืนไม่ได้")).toBeTruthy();
    expect(store.lastRunWrites).toHaveLength(0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ไม่ล้าง" }));
    });
    await settle();
    expect(store.lastRunWrites).toHaveLength(0);
    expect(screen.getAllByText("12:34").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "ล้าง" })).toBeTruthy();
    expect(modal).not.toHaveBeenCalled();
  });

  it("answered yes: cleared as before", async () => {
    const modal = vi.spyOn(window, "confirm");
    await boot();
    await act(async () => {
      fireEvent.click(clearKey());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ล้างเลย" }));
    });
    await settle();
    expect(store.lastRunWrites).toEqual([null]);
    expect(screen.queryByRole("button", { name: "ล้าง" })).toBeNull();
    expect(modal).not.toHaveBeenCalled();
  });
});
