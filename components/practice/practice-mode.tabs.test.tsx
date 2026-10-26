// The practice room's two tabs keep what a band has going in each across a switch:
// a journal note being typed while they hop to เครื่องเล่น to replay the bar it is
// about; a break timer counting down while they open สมุดซ้อม to write the summary;
// the song itself. (Radix unmounts an inactive TabsContent unless told otherwise.)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { Member, PracticeSong, Song } from "@/lib/types";

const h = vi.hoisted(() => ({ destroyed: 0, pauses: 0, logReads: 0 }));

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    playing = false;
    onTime: (t: number) => void = () => {};
    onDuration: (d: number) => void = () => {};
    onPlayingChange: (p: boolean) => void = () => {};
    onEnded: () => void = () => {};
    onPreparing: (p: boolean) => void = () => {};
    onStretchFailed: (e: unknown) => void = () => {};
    unlock() {}
    stopTails() {}
    handOff() {
      return false;
    }
    preload() {}
    clearPreload() {}
    async load() {}
    async play() {}
    pause() {
      h.pauses++;
    }
    toggle() {}
    seek() {}
    setTempo() {}
    setVolume() {}
    destroy() {
      h.destroyed++;
    }
    async getBuffer() {
      return null;
    }
  },
}));
vi.mock("@/lib/song-cache", () => ({ getSongBlob: (path: string) => Promise.resolve({ path }) }));
vi.mock("@/lib/local-source", () => ({
  getLocalSource: async () => null,
  listLocalSourceIds: async () => [],
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/bpm-detect", () => ({ detectBeats: () => null }));
vi.mock("@/components/practice/metronome", () => ({ Metronome: () => null }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "practice_logs") h.logReads++;
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "order", "insert", "update", "delete"]) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(ok, fail);
      return b;
    },
  }),
}));

import { PracticeMode } from "@/components/practice/practice-mode";

const song = { id: "a", tenant_id: "t1", group_id: "g1", title: "Neon Samurai", duration_seconds: 228, audio_path: "a.wav" } as Song;
const list = [{ id: "p-a", song_id: "a", sort_order: 1 } as PracticeSong];
const members = [{ id: "m1", group_id: "g1", name: "มายด์", nickname: "มายด์", color: null, sort_order: 0 } as unknown as Member];

const mount = () =>
  render(
    <ConfirmProvider>
      <PracticeMode
        roomName="ซ้อมก่อนงาน"
        eventId="room"
        groupId="g1"
        tenantId="t1"
        songs={[song]}
        practiceList={list}
        markersBySong={{}}
        members={members}
        canManage
        currentUserId="u1"
      />
    </ConfirmProvider>
  );

// Radix tabs activate on mousedown
const openTab = async (name: RegExp) => {
  await act(async () => {
    fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

beforeEach(() => {
  h.destroyed = 0;
  h.pauses = 0;
  h.logReads = 0;
});

describe("practice room tab switch", () => {
  it("keeps a journal note being typed across a trip to the player", async () => {
    mount();
    await openTab(/สมุดซ้อม/);
    const box = await screen.findByLabelText("บันทึกการซ้อม");
    fireEvent.change(box, { target: { value: "ท่อน Hook ห้อง 3 คีย์เพี้ยน — มายด์เข้าช้า" } });
    await openTab(/เครื่องเล่น/);
    await openTab(/สมุดซ้อม/);
    const again = (await screen.findByLabelText("บันทึกการซ้อม")) as HTMLTextAreaElement;
    expect(again.value).toBe("ท่อน Hook ห้อง 3 คีย์เพี้ยน — มายด์เข้าช้า");
  });

  it("keeps a running break timer across a trip to the journal", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /เวลาพัก/ }));
    fireEvent.click(screen.getByRole("button", { name: /10\s*นาที/ }));
    expect(screen.getByRole("button", { name: "หยุดเวลาพักชั่วคราว" })).toBeTruthy();
    await openTab(/สมุดซ้อม/);
    // the player is out of sight (and out of the accessibility tree) meanwhile
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
    await openTab(/เครื่องเล่น/);
    expect(screen.getByRole("region", { name: "Now playing" })).toBeTruthy();
    // the break is still counting down (else the end-of-break beep never comes)
    expect(screen.queryByRole("button", { name: "หยุดเวลาพักชั่วคราว" })).not.toBeNull();
  });

  it("leaves the song alone: the player is not torn down by the switch", async () => {
    mount();
    await openTab(/สมุดซ้อม/);
    await openTab(/เครื่องเล่น/);
    expect(h.destroyed).toBe(0);
    expect(h.pauses).toBe(0);
  });

  it("reads the journal only once it is opened, and afresh on every open", async () => {
    mount();
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(h.logReads).toBe(0);
    await openTab(/สมุดซ้อม/);
    expect(h.logReads).toBe(1);
    await openTab(/เครื่องเล่น/);
    await openTab(/สมุดซ้อม/);
    expect(h.logReads).toBe(2);
  });
});
