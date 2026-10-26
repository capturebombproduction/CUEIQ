// 2026-10-27 hunt (livecore): every clear on the device-storage strip asks first.
//
// "ล้างทั้งหมด" is a small footer link under the events list, and one stray tap deleted every
// cached show file on this device - the coming show's prepared masters (re-downloaded at
// the venue, maybe with no network) and any LOCAL-ONLY copy (path null: a file picked in
// Live whose upload failed, which lib/audio-prefetch.ts calls the only copy that exists).
// 2d88619's rule: every user-initiated delete prompts before it runs.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

const store = vi.hoisted(() => ({
  clearAllAudio: vi.fn(async () => {}),
  clearEventAudio: vi.fn(async () => 0),
  clearSongCache: vi.fn(async () => {}),
  getCacheSummary: vi.fn(async () => ({
    totalBytes: 300 * 1024 * 1024,
    fileCount: 6,
    byEvent: {
      "upcoming-show": { bytes: 300 * 1024 * 1024, count: 6 },
      "last-week": { bytes: 100 * 1024 * 1024, count: 2 },
    },
  })),
}));
vi.mock("@/lib/audio-store", () => ({
  clearAllAudio: store.clearAllAudio,
  clearEventAudio: store.clearEventAudio,
  getCacheSummary: store.getCacheSummary,
}));
vi.mock("@/lib/song-cache", () => ({
  getSongCacheSummary: vi.fn(async () => ({ totalBytes: 50 * 1024 * 1024, count: 3 })),
  clearSongCache: store.clearSongCache,
}));

import { DeviceStorage } from "@/components/event/device-storage";

beforeEach(() => {
  store.clearAllAudio.mockClear();
  store.clearEventAudio.mockClear();
  store.clearSongCache.mockClear();
});

async function mount() {
  render(
    <ConfirmProvider>
      <DeviceStorage pastEventIds={["last-week"]} />
    </ConfirmProvider>
  );
  await act(async () => {});
}

async function tap(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

describe("DeviceStorage — every clear asks first", () => {
  it("ล้างทั้งหมด: a stray tap deletes nothing until the operator confirms", async () => {
    await mount();
    await tap(await screen.findByText("ล้างทั้งหมด"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("งานที่กำลังจะถึง");
    expect(store.clearAllAudio).not.toHaveBeenCalled();
    await tap(within(dialog).getByRole("button", { name: "ยกเลิก" }));
    expect(store.clearAllAudio).not.toHaveBeenCalled();
    expect(store.clearSongCache).not.toHaveBeenCalled();

    await tap(screen.getByText("ล้างทั้งหมด"));
    await tap(within(await screen.findByRole("dialog")).getByRole("button", { name: "ล้างทั้งหมด" }));
    expect(store.clearAllAudio).toHaveBeenCalledTimes(1);
  });

  it("the preload library and the past shows ask too", async () => {
    await mount();
    await tap(await screen.findByText(/ล้างคลังพรีโหลด/));
    await tap(within(await screen.findByRole("dialog")).getByRole("button", { name: "ยกเลิก" }));
    await tap(screen.getByText(/ล้างงานที่ผ่านแล้ว/));
    await tap(within(await screen.findByRole("dialog")).getByRole("button", { name: "ยกเลิก" }));
    expect(store.clearSongCache).not.toHaveBeenCalled();
    expect(store.clearEventAudio).not.toHaveBeenCalled();
  });
});
