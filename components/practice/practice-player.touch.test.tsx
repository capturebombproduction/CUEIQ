// Round 15 — the practice player on a touch iPad and on Safari without
// `scrollbar-width`.
//  • CQ-36: `h-11 sm:h-9` used the 640px breakpoint as a stand-in for "has a mouse", so
//    a touch iPad (768+) got 36px loop / marker buttons. The shrink now keys on the
//    pointer: only a fine pointer gets the dense 36px.
//  • CQ-62: the section-chip row hides its scrollbar through `.no-scrollbar`
//    (stage.css — the web and the .exe both load it), which carries the ::-webkit-scrollbar twin a Tailwind
//    `[scrollbar-width:none]` cannot. jsdom has no layout: these are class pins, and
//    the real-browser size check is the 768 hasTouch harness.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import type { PracticeSong, Song, SongMarker } from "@/lib/types";

const h = vi.hoisted(() => ({ engines: [] as { loads: string[] }[] }));

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    loads: string[] = [];
    playing = false;
    onTime: (t: number) => void = () => {};
    onDuration: (d: number) => void = () => {};
    onPlayingChange: (p: boolean) => void = () => {};
    onEnded: () => void = () => {};
    onPreparing: (p: boolean) => void = () => {};
    onStretchFailed: (e: unknown) => void = () => {};
    constructor() {
      h.engines.push(this);
    }
    unlock() {}
    stopTails() {}
    handOff() {
      return false;
    }
    preload() {}
    clearPreload() {}
    async load(b: { path: string }) {
      this.loads.push(b.path);
    }
    async play() {
      this.playing = true;
      this.onPlayingChange(true);
    }
    pause() {}
    toggle() {}
    seek() {}
    setTempo() {}
    setVolume() {}
    destroy() {}
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
vi.mock("@/components/practice/break-timer", () => ({ BreakTimer: () => null }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => {
      const b = {
        select: () => b,
        eq: () => b,
        gte: () => b,
        insert: () => b,
        then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
      };
      return b;
    },
  }),
}));

import { PracticePlayer } from "./practice-player";

const song = (id: string, title: string): Song =>
  ({ id, tenant_id: "t1", group_id: "g1", title, duration_seconds: 228, audio_path: `${id}.wav` }) as Song;
const songs = [song("a", "Seishin Kakumei")];
const items = songs.map((s, i) => ({ id: `p-${s.id}`, song_id: s.id, sort_order: i }) as PracticeSong);
const markers: Record<string, SongMarker[]> = {
  a: [
    ["m1", "Intro", 0],
    ["m2", "Hook", 71],
  ].map(([id, label, pos]) => ({ id, song_id: "a", label, position_seconds: pos }) as SongMarker),
};

const mount = () =>
  render(
    <ConfirmProvider>
      <PracticePlayer
        roomName="ห้องซ้อม"
        eventId="room"
        groupId="g1"
        currentUserId="u1"
        songs={songs}
        items={items}
        setItems={() => {}}
        markers={markers}
        setMarkers={() => {}}
        canManage={false}
        canCurate
      />
    </ConfirmProvider>
  );

const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
const FINE_36 = "[@media(pointer:fine)]:h-9";

beforeEach(() => {
  h.engines = [];
});

async function withSong() {
  const view = mount();
  fireEvent.click(screen.getByRole("button", { name: /Seishin Kakumei/ }));
  await waitFor(() => expect(h.engines.at(-1)?.loads).toContain("a.wav"));
  return view;
}

describe("PracticePlayer — touch sizes (CQ-36)", () => {
  it("the loop and marker buttons are 44px for a touch pointer and shrink only for a fine one", async () => {
    await withSong();
    fireEvent.click(screen.getByRole("button", { name: /แก้ไข/ }));
    const buttons = [
      screen.getByRole("button", { name: /Mark In/ }),
      screen.getByRole("button", { name: /Mark Out/ }),
      screen.getByRole("button", { name: /^วน$/ }),
      screen.getByRole("button", { name: /ล้างทั้งหมด/ }),
      screen.getByRole("button", { name: /เสร็จ/ }),
    ];
    for (const b of buttons) {
      const c = classes(b);
      expect(c, b.textContent ?? "").toContain("h-11");
      expect(c, b.textContent ?? "").toContain(FINE_36);
    }
  });

  it("nothing in the player still shrinks at sm: — 640px is a width, not a mouse", async () => {
    const { container } = await withSong();
    fireEvent.click(screen.getByRole("button", { name: /แก้ไข/ }));
    expect(container.querySelectorAll('[class*="sm:h-9"]')).toHaveLength(0);
  });
});

describe("PracticePlayer — the section-chip row's scrollbar (CQ-62)", () => {
  it("hides it through .no-scrollbar alone (stage.css reaches the .exe too)", async () => {
    await withSong();
    const row = within(screen.getByRole("region", { name: "Now playing" })).getByRole("group", {
      name: "ท่อนเพลง",
    });
    const c = classes(row);
    expect(c).toContain("no-scrollbar");
    // one rule, in the shared sheet (see app/globals.css.test.ts, which follows the
    // .exe's import chain) — the bare Tailwind property is no longer needed beside it
    expect(c).not.toContain("[scrollbar-width:none]");
    // it still scrolls sideways — only the bar is hidden
    expect(c).toContain("overflow-x-auto");
  });
});
