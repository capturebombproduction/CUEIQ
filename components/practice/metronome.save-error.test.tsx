// "บันทึกลงเพลง" refused by the server says why in Thai - the room's write-failure
// sentence - never the raw PostgREST text inside the Thai toast.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { toast } from "sonner";
import type { Song } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
vi.mock("@/lib/count-samples", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/count-samples")>()),
  loadCountSamples: () => new Promise<ArrayBuffer[]>(() => {}),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["update", "eq", "select"]) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve({
          data: null,
          error: { code: "42501", message: "permission denied for table songs" },
        }).then(ok, fail);
      return b;
    },
  }),
}));

import { Metronome } from "@/components/practice/metronome";

beforeEach(() => {
  class FakeCtx {
    state = "running";
    currentTime = 0;
    async resume() {}
    async close() {}
    async decodeAudioData() {
      return {};
    }
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeCtx;
});

describe("metronome - save BPM refused", () => {
  it("tells the Ar in Thai, without the server's English", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const song = { id: "s1", title: "Neon Samurai", bpm: 120, audio_path: "s1.wav" } as unknown as Song;
    render(<Metronome song={song} canManage />);
    fireEvent.click(screen.getByRole("button", { name: /เมโทรนอม/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /บันทึกลงเพลง/ }));
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
    const [title, opts] = vi.mocked(toast.error).mock.calls[0] as [string, { description: string }];
    expect(title).toBe("บันทึก BPM ไม่สำเร็จ");
    expect(opts.description).not.toMatch(/permission denied|songs/);
    expect(opts.description).toMatch(/[฀-๿]/); // Thai
    quiet.mockRestore();
  });
});
