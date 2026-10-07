// "ซ้อมตามเซ็ตลิสต์" — the band rehearses the next show's set in order (88 logged
// runs say so), and the player used to stop after every song. What this pins is
// the part no screenshot shows: a song ENDING starts the next one, the set ends
// itself, and picking some other song by hand leaves the run instead of being
// yanked back into it when that song ends.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { bkkTodayKey } from "@/lib/time";
import type { PracticeSong, Song } from "@/lib/types";

type FakeEngine = {
  loads: string[];
  /** the song that was sounding at each hand-off ("เล่นซ้อน") */
  handOffs: string[];
  stopTails: () => void;
  tailsStopped: number;
  onEnded: () => void;
  onTime: (t: number) => void;
  onPlayingChange: (p: boolean) => void;
  duration: number;
  position: number;
  playing: boolean;
  /** false = no element that may play the next song (iOS): canHandOff says no */
  handOffReady: boolean;
  toggles: number;
};
const h = vi.hoisted(() => ({
  engines: [] as FakeEngine[],
  shows: [] as unknown[],
  updates: [] as { table: string; values: Record<string, unknown>; id: unknown }[],
  failUpdate: false,
  /** per update, in order: fail it, and/or hold its answer back this many ms */
  updatePlan: [] as { fail?: boolean; delay?: number }[],
  /** what reached the server, and when it answered — to see writes never overlap */
  writeLog: [] as string[],
  broadcasts: [] as { topic: string; event: string }[],
  /** the channels open per topic - supabase.channel() hands back the open one */
  channels: new Map<string, unknown>(),
  /** how long removeChannel takes to be done with one (a leave is a round trip) */
  leaveMs: 0,
  /** while set, load() waits on it — the slowed-down decode of a hand-off */
  loadGate: null as Promise<void> | null,
}));

vi.mock("@/lib/practice-audio", () => ({
  PracticeAudioEngine: class {
    loads: string[] = [];
    handOffs: string[] = [];
    tailsStopped = 0;
    duration = 200;
    position = 0;
    playing = false;
    handOffReady = true;
    tailing = false;
    get songDuration() {
      return this.duration;
    }
    get canHandOff() {
      return this.playing && this.handOffReady;
    }
    get handingOff() {
      return this.tailing && !this.playing;
    }
    clearPreload() {}
    onTime: (t: number) => void = () => {};
    onDuration: (d: number) => void = () => {};
    onPlayingChange: (p: boolean) => void = () => {};
    onEnded: () => void = () => {};
    onPreparing: (p: boolean) => void = () => {};
    onStretchFailed: (e: unknown) => void = () => {};
    constructor() {
      h.engines.push(this as unknown as FakeEngine);
    }
    unlock() {}
    stopTails() {
      this.tailsStopped++;
    }
    handOff() {
      if (!this.playing) return false;
      this.handOffs.push(this.loads[this.loads.length - 1]);
      this.tailing = true;
      this.playing = false;
      this.onPlayingChange(false);
      return true;
    }
    preload() {}
    async load(b: { path: string }) {
      if (h.loadGate) await h.loadGate;
      this.loads.push(b.path);
      this.position = 0;
    }
    async play() {
      this.playing = true;
      this.onPlayingChange(true);
    }
    pause() {
      if (this.tailing) this.tailsStopped++;
      this.tailing = false;
      this.playing = false;
      this.onPlayingChange(false);
    }
    toggles = 0;
    toggle() {
      this.toggles++;
    }
    seek() {}
    setTempo() {}
    setVolume() {}
    destroy() {}
    async getBuffer() {
      return null;
    }
  },
}));
const blob = vi.hoisted(() => ({
  // per-path override: a rejection, or a promise the test resolves itself
  special: new Map<string, () => Promise<unknown>>(),
}));
vi.mock("@/lib/song-cache", () => ({
  getSongBlob: (path: string) => blob.special.get(path)?.() ?? Promise.resolve({ path }),
}));
vi.mock("@/lib/local-source", () => ({
  getLocalSource: async () => null,
  listLocalSourceIds: async () => [],
}));
vi.mock("@/lib/mgmt-outbox", () => ({ MGMT_OUTBOX_EVENT: "cueiq-test-outbox" }));
vi.mock("@/lib/bpm-detect", () => ({ detectBeats: () => null }));
vi.mock("@/components/practice/metronome", () => ({ Metronome: () => null }));
vi.mock("@/components/practice/break-timer", () => ({ BreakTimer: () => null }));
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string) => toastError(m),
    info: vi.fn(),
  },
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: (topic: string) => {
      // as realtime-js does: the channel still open on this topic comes back, and a
      // subscribe() on a channel already joined never calls back
      const open = h.channels.get(topic);
      if (open) return open;
      let joined = false;
      const ch = {
        subscribe: (cb: (s: string) => void) => {
          if (joined) return ch;
          joined = true;
          cb("SUBSCRIBED");
          return ch;
        },
        send: (m: { event: string }) => {
          h.broadcasts.push({ topic, event: m.event });
          return Promise.resolve("ok");
        },
      };
      h.channels.set(topic, ch);
      return ch;
    },
    removeChannel: (ch: unknown) =>
      new Promise((r) => setTimeout(r, h.leaveMs)).then(() => {
        for (const [t, c] of h.channels) if (c === ch) h.channels.delete(t);
        return "ok";
      }),
    from: (table: string) => {
      let update: Record<string, unknown> | null = null;
      const b = {
        select: () => b,
        eq: (col: string, v: unknown) => {
          if (update && col === "id") h.updates.push({ table, values: update, id: v });
          return b;
        },
        gte: () => b,
        insert: () => b,
        update: (v: Record<string, unknown>) => {
          update = v;
          return b;
        },
        then: (res: (v: unknown) => unknown) => {
          if (table === "events") return Promise.resolve({ data: h.shows, error: null }).then(res);
          if (!update) return Promise.resolve({ data: null, error: null }).then(res);
          const v = (update as { buffer_before_seconds?: number }).buffer_before_seconds;
          const plan = h.updatePlan.shift() ?? {};
          const fail = plan.fail ?? h.failUpdate;
          h.writeLog.push(`send ${v}`);
          return new Promise((r) => setTimeout(r, plan.delay ?? 0))
            .then(() => {
              h.writeLog.push(`done ${v}`);
              return fail
                ? { data: null, error: { code: "42501", message: "permission denied" } }
                : { data: [{ id: "x" }], error: null };
            })
            .then(res);
        },
      };
      return b;
    },
  }),
}));

import { PracticePlayer } from "./practice-player";

const song = (id: string, title: string): Song =>
  ({ id, tenant_id: "t1", group_id: "g1", title, duration_seconds: 200, audio_path: `${id}.wav` }) as Song;
const songs = [
  song("boot", "[SYSTEM_BOOT] SE"),
  song("neon", "Neon Lullaby"),
  song("iam", "I Am Who I Am"),
  song("other", "Transmission Failure"),
];
const row = (id: string, sort: number, song_id: string | null, kind = "song") => ({
  id,
  title: id,
  kind,
  song_id,
  sort_order: sort,
});
const items = [{ id: "p1", song_id: "other", sort_order: 1 } as PracticeSong];

beforeEach(() => {
  h.engines = [];
  h.updates = [];
  h.failUpdate = false;
  h.updatePlan = [];
  h.writeLog = [];
  h.broadcasts = [];
  h.channels.clear();
  h.leaveMs = 0;
  h.loadGate = null;
  toastSuccess.mockClear();
  toastError.mockClear();
  blob.special.clear();
  h.shows = [
    {
      id: "show-1",
      name: "Thailand hobbyfestival",
      event_date: bkkTodayKey(),
      setlist_items: [
        row("r1", 1, "boot"),
        row("r2", 2, "neon"),
        row("mc", 3, null, "mc"),
        row("r3", 4, "iam"),
      ],
    },
  ];
});

const mount = ({ canManage = false } = {}) =>
  render(
    <ConfirmProvider>
      <PracticePlayer
        eventId="room"
        groupId="g1"
        currentUserId="u1"
        songs={songs}
        items={items}
        setItems={() => {}}
        markers={{}}
        setMarkers={() => {}}
        canManage={canManage}
        canCurate={false}
      />
    </ConfirmProvider>
  );
const engine = () => h.engines[h.engines.length - 1];
const end = () => act(() => engine().onEnded());

describe("PracticePlayer — ซ้อมตามเซ็ตลิสต์", () => {
  it("plays the set in order, each song starting as the last one ends, then stops", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /เล่นทั้งเซ็ต \(3 เพลง\)/ }));
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav"]));

    end();
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "neon.wav"]));
    // the MC row is not a song — the run goes straight past it
    end();
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "neon.wav", "iam.wav"]));

    end();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("ซ้อมครบทั้งเซ็ตแล้ว"));
    expect(engine().loads).toHaveLength(3);
    expect(screen.getByRole("button", { name: /เล่นทั้งเซ็ต/ })).toBeTruthy();
  });

  it("picking another song by hand leaves the run — its end does not jump back into the set", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /เล่นทั้งเซ็ต/ }));
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav"]));

    fireEvent.click(screen.getByRole("button", { name: /Transmission Failure/ }));
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "other.wav"]));

    end();
    await new Promise((r) => setTimeout(r, 30));
    expect(engine().loads).toEqual(["boot.wav", "other.wav"]);
  });

  // Review finding 1: a failed load mid-set used to leave the card claiming
  // "เพลงที่ 2/3" over a player still holding song 1.
  it("a song that fails to load stops the set instead of pointing at nothing", async () => {
    blob.special.set("neon.wav", () => Promise.reject(new Error("offline")));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /เล่นทั้งเซ็ต/ }));
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav"]));
    end();
    await waitFor(() => expect(screen.getByRole("button", { name: /เล่นทั้งเซ็ต/ })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /หยุดเล่นต่อ/ })).toBeNull();
    end(); // the old song ending again must not resume the set
    await new Promise((r) => setTimeout(r, 30));
    expect(engine().loads).toEqual(["boot.wav"]);
  });

  // Review finding 4: tap a row in the last seconds of a song; that song ending
  // while the tapped one downloads must not overrule the tap.
  it("a row tapped while the current song runs out wins over the auto-advance", async () => {
    let release!: () => void;
    blob.special.set("neon.wav", () => new Promise((r) => (release = () => r({ path: "neon.wav" }))));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /เล่นทั้งเซ็ต/ }));
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav"]));
    // row 2 (NOT the last — a last row has nothing after it to wrongly jump to)
    fireEvent.click(screen.getByRole("button", { name: /Neon Lullaby/ }));
    end(); // boot runs out while neon is still downloading
    await new Promise((r) => setTimeout(r, 30));
    release();
    await new Promise((r) => setTimeout(r, 30));
    // without the guard the end would move the set to row 3 and play iam instead
    expect(engine().loads).toEqual(["boot.wav", "neon.wav"]);
  });

  // Review finding 3: looking at another show mid-set must not hide the stop.
  it("keeps the stop button when another show is picked in the dropdown mid-set", async () => {
    h.shows = [
      ...h.shows,
      { id: "show-2", name: "Next week", event_date: bkkTodayKey(), setlist_items: [row("x", 1, "neon")] },
    ];
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /เล่นทั้งเซ็ต/ }));
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav"]));
    fireEvent.change(screen.getByLabelText("เลือกงานที่จะซ้อม"), { target: { value: "show-2" } });
    expect(screen.getByRole("button", { name: /หยุดเล่นต่อ/ })).toBeTruthy();
    expect(screen.getByText(/กำลังเล่นตามเซ็ตของ “Thailand hobbyfestival”/)).toBeTruthy();
  });

  // Phone layout (2026-09-28): the loop + marker tools fold behind one button —
  // 0 markers and 0 slowed runs in 96 real practice runs — so the set list stays
  // on the first screen. Pinned: a song that HAS markers never folds them.
  it("folds the section tools for a song without markers, never for one with them", async () => {
    const { rerender } = mount();
    fireEvent.click(await screen.findByRole("button", { name: /เล่นทั้งเซ็ต/ }));
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav"]));
    expect(screen.getByRole("button", { name: /วนท่อน \/ ท่อนเพลง/ })).toBeTruthy();

    rerender(
      <ConfirmProvider>
        <PracticePlayer
          eventId="room"
          groupId="g1"
          currentUserId="u1"
          songs={songs}
          items={items}
          setItems={() => {}}
          markers={{ boot: [{ id: "m1", song_id: "boot", label: "Intro", position_seconds: 5 } as never] }}
          setMarkers={() => {}}
          canManage={false}
          canCurate={false}
        />
      </ConfirmProvider>
    );
    expect(screen.queryByRole("button", { name: /วนท่อน \/ ท่อนเพลง/ })).toBeNull();
  });

  it("a song ending with no run going does nothing", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Transmission Failure/ }));
    await waitFor(() => expect(engine().loads).toEqual(["other.wav"]));
    end();
    await new Promise((r) => setTimeout(r, 30));
    expect(engine().loads).toEqual(["other.wav"]);
  });
});

// Review 2026-09-28: clearing a song's markers folded the tools away under the tap.
describe("PracticePlayer — tools opened by use stay open", () => {
  it("keeps the section tools open after the song's markers are cleared", async () => {
    const withMarkers = { boot: [{ id: "m1", song_id: "boot", label: "Intro", position_seconds: 5 } as never] };
    const view = (markers: Record<string, never[]>) => (
      <ConfirmProvider>
        <PracticePlayer
          eventId="room"
          groupId="g1"
          currentUserId="u1"
          songs={songs}
          items={items}
          setItems={() => {}}
          markers={markers}
          setMarkers={() => {}}
          canManage={false}
          canCurate={false}
        />
      </ConfirmProvider>
    );
    const { rerender } = render(view(withMarkers));
    fireEvent.click(await screen.findByRole("button", { name: /เล่นทั้งเซ็ต/ }));
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav"]));
    expect(screen.queryByRole("button", { name: /วนท่อน \/ ท่อนเพลง/ })).toBeNull(); // open
    rerender(view({})); // "ล้างทั้งหมด" → no markers left
    expect(screen.queryByRole("button", { name: /วนท่อน \/ ท่อนเพลง/ })).toBeNull(); // still open
  });
});

// "เล่นซ้อน" (พี่ 2026-10-07): the next song comes in N seconds before this one ends,
// the number being the show's own (the one Live Mode plays — Welcome to friendverse
// had -5 / -3 / -3 / -3). The fake engine's songs are 200 s long.
describe("PracticePlayer — เล่นซ้อน", () => {
  beforeEach(() => {
    h.shows = [
      {
        id: "show-1",
        name: "Welcome to friendverse",
        event_date: bkkTodayKey(),
        setlist_items: [
          row("r1", 1, "boot"),
          { ...row("r2", 2, "neon"), buffer_before_seconds: -5 },
          { ...row("mc", 3, null, "mc"), buffer_before_seconds: -4 },
          // in the show this one overlaps the MC, not Neon Lullaby
          { ...row("r3", 4, "iam"), buffer_before_seconds: -3 },
        ],
      },
    ];
  });
  /** the playhead reaches `t` (and the engine reports it, as timeupdate does) */
  const at = (t: number) =>
    act(() => {
      engine().position = t;
      engine().onTime(t);
    });
  const startSet = async () => {
    fireEvent.click(await screen.findByRole("button", { name: /เล่นทั้งเซ็ต/ }));
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav"]));
  };
  const chip = (text: string) =>
    screen.queryAllByText(
      (_, el) => el?.tagName === "P" && el.textContent?.replace(/\s+/g, " ").trim() === text
    );

  it("brings the next song in on its second, over the end of this one", async () => {
    mount();
    await startSet();
    expect(screen.getByText(/เพลงถัดไปเข้าก่อนจบ 5 วิ/)).toBeTruthy();
    at(150); // 50 s to go — nothing yet
    await new Promise((r) => setTimeout(r, 30));
    expect(engine().loads).toEqual(["boot.wav"]);

    at(194.6); // 0.4 s before its moment: armed for it, not started early
    await new Promise((r) => setTimeout(r, 200));
    expect(engine().loads).toEqual(["boot.wav"]);
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "neon.wav"]));
    // boot was handed off to finish underneath — not cut, and its tail not silenced
    expect(engine().handOffs).toEqual(["boot.wav"]);
    expect(engine().tailsStopped).toBe(1); // only the set's first load cleared tails
    expect(screen.getByText(/กำลังเล่นเพลงที่ 2\/3/)).toBeTruthy();
  });

  it("after an MC the song is not laid over the one before — it waits for the end", async () => {
    mount();
    await startSet();
    at(195.5);
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "neon.wav"]));
    at(198.5); // inside I Am Who I Am's 3 s — which belongs to the MC
    await new Promise((r) => setTimeout(r, 50));
    expect(engine().loads).toEqual(["boot.wav", "neon.wav"]);
    end();
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "neon.wav", "iam.wav"]));
    expect(engine().handOffs).toEqual(["boot.wav"]);
  });

  it("a pause before the moment holds the next song back", async () => {
    mount();
    await startSet();
    at(194.6);
    act(() => {
      engine().playing = false;
      engine().onPlayingChange(false);
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(engine().loads).toEqual(["boot.wav"]);
  });

  it("shows each overlap between the two songs it joins, and nowhere else", async () => {
    mount();
    await screen.findByRole("button", { name: /เล่นทั้งเซ็ต/ });
    expect(chip("ซ้อน 5 วิ")).toHaveLength(1);
    expect(chip("ซ้อน 3 วิ")).toHaveLength(0); // I Am Who I Am's sits after the MC
    // a member sees the numbers; setting them is the band editor's
    expect(screen.queryByRole("button", { name: /ตั้งเล่นซ้อน/ })).toBeNull();
  });

  it("an editor sets it with − / + and it is saved, once, to the show's own setlist", async () => {
    mount({ canManage: true });
    fireEvent.click(await screen.findByRole("button", { name: /ตั้งเล่นซ้อน/ }));
    const plus = screen.getByRole("button", { name: "เพิ่มเวลาเล่นซ้อน · Neon Lullaby" });
    fireEvent.click(plus);
    await new Promise((r) => setTimeout(r, 150)); // a person's pace between presses
    fireEvent.click(plus);
    expect(screen.getByLabelText("เล่นซ้อน Neon Lullaby 7 วินาที")).toBeTruthy();
    expect(h.updates).toHaveLength(0); // waits for the presses to stop
    await waitFor(() => expect(h.updates).toHaveLength(1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 150));
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toEqual({
      table: "setlist_items",
      values: { buffer_before_seconds: -7 },
      id: "r2",
    });
    // no stepper into the first song, nor into one that follows an MC
    expect(screen.queryByRole("button", { name: /เล่นซ้อน · \[SYSTEM_BOOT\] SE/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /เล่นซ้อน · I Am Who I Am/ })).toBeNull();
  });

  it("a save the server refuses goes back to the show's number and says so", async () => {
    h.failUpdate = true;
    mount({ canManage: true });
    fireEvent.click(await screen.findByRole("button", { name: /ตั้งเล่นซ้อน/ }));
    fireEvent.click(screen.getByRole("button", { name: "ลดเวลาเล่นซ้อน · Neon Lullaby" }));
    expect(screen.getByLabelText("เล่นซ้อน Neon Lullaby 4 วินาที")).toBeTruthy();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("บันทึกเล่นซ้อนไม่สำเร็จ"), {
      timeout: 2000,
    });
    expect(screen.getByLabelText("เล่นซ้อน Neon Lullaby 5 วินาที")).toBeTruthy();
  });

  it("an overlap taken out mid-set is heard at once: the next song waits for the end", async () => {
    mount({ canManage: true });
    await startSet();
    fireEvent.click(screen.getByRole("button", { name: /ตั้งเล่นซ้อน/ }));
    const minus = screen.getByRole("button", { name: "ลดเวลาเล่นซ้อน · Neon Lullaby" });
    for (let i = 0; i < 5; i++) fireEvent.click(minus);
    expect(screen.getByLabelText("เล่นซ้อน Neon Lullaby 0 วินาที")).toBeTruthy();
    at(199);
    await new Promise((r) => setTimeout(r, 50));
    expect(engine().loads).toEqual(["boot.wav"]);
    end();
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "neon.wav"]));
    expect(engine().handOffs).toEqual([]);
    // let its save land here, not in the next test
    await waitFor(() => expect(h.writeLog).toContain("done 0"), { timeout: 2000 });
  });

  // Review 2026-10-07 #1: on venue wifi a press's write can still be out when the next
  // press saves. The writes must reach the server in order, and an OLDER one failing
  // must not put the number back over a newer one that is about to land.
  it("writes go out one after another, and an older failure never reverts a newer press", async () => {
    const mine = () => h.writeLog.filter((e) => /-[67]$/.test(e));
    h.updatePlan = [{ fail: true, delay: 900 }, { delay: 0 }];
    mount({ canManage: true });
    fireEvent.click(await screen.findByRole("button", { name: /ตั้งเล่นซ้อน/ }));
    const plus = screen.getByRole("button", { name: "เพิ่มเวลาเล่นซ้อน · Neon Lullaby" });
    fireEvent.click(plus); // 6 — its write leaves at ~0.7 s and fails at ~1.6 s
    await waitFor(() => expect(mine()).toEqual(["send -6"]), { timeout: 2000 });
    fireEvent.click(plus); // 7 — saved at ~1.5 s, while 6 is still out
    await waitFor(() => expect(mine()).toEqual(["send -6", "done -6", "send -7", "done -7"]), {
      timeout: 3000,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(toastError).toHaveBeenCalledTimes(1); // 6 did fail, and says so
    expect(screen.getByLabelText("เล่นซ้อน Neon Lullaby 7 วินาที")).toBeTruthy(); // = the server
  });

  // 2026-10-07 review: the second notice used to ride a channel that was still leaving,
  // whose subscribe() never called back - nothing was sent for the second transition.
  it("two transitions saved a second apart: Live Mode hears both", async () => {
    h.shows = [
      {
        id: "show-1",
        name: "Welcome to friendverse",
        event_date: bkkTodayKey(),
        setlist_items: [
          row("r1", 1, "boot"),
          { ...row("r2", 2, "neon"), buffer_before_seconds: -5 },
          { ...row("r3", 3, "iam"), buffer_before_seconds: -3 },
        ],
      },
    ];
    h.leaveMs = 1500;
    mount({ canManage: true });
    fireEvent.click(await screen.findByRole("button", { name: /ตั้งเล่นซ้อน/ }));
    fireEvent.click(screen.getByRole("button", { name: "เพิ่มเวลาเล่นซ้อน · Neon Lullaby" }));
    await waitFor(() => expect(h.broadcasts).toHaveLength(1), { timeout: 2000 });
    fireEvent.click(screen.getByRole("button", { name: "เพิ่มเวลาเล่นซ้อน · I Am Who I Am" }));
    await waitFor(() => expect(h.broadcasts).toHaveLength(2), { timeout: 4000 });
    expect(h.broadcasts.every((b) => b.topic === "live:show-1" && b.event === "setlist-changed")).toBe(true);
  }, 10_000);

  it("a saved overlap tells a Live Mode screen open on that show to pull the setlist", async () => {
    mount({ canManage: true });
    fireEvent.click(await screen.findByRole("button", { name: /ตั้งเล่นซ้อน/ }));
    fireEvent.click(screen.getByRole("button", { name: "เพิ่มเวลาเล่นซ้อน · Neon Lullaby" }));
    await waitFor(() =>
      expect(h.broadcasts).toEqual([{ topic: "live:show-1", event: "setlist-changed" }])
    , { timeout: 2000 });
  });

  // Review #6: the run moves on before the file is read; a file that is not there must
  // stop the set, or the song still playing ends into the one after and skips this one.
  it("an overlap whose song has no file stops the set instead of skipping it", async () => {
    blob.special.set("neon.wav", () => Promise.resolve(null));
    mount();
    await startSet();
    at(195.5);
    await waitFor(() => expect(screen.getByRole("button", { name: /เล่นทั้งเซ็ต/ })).toBeTruthy());
    end(); // boot, still playing, runs out
    await new Promise((r) => setTimeout(r, 50));
    expect(engine().loads).toEqual(["boot.wav"]);
  });

  // Review #2: with no element WebKit has let play (iOS, a spare never primed), an
  // overlap would start the next song silent. It waits for the end instead.
  it("with nowhere to play the next song yet, the set waits for this one to end", async () => {
    mount();
    await startSet();
    engine().handOffReady = false;
    at(195.5);
    await new Promise((r) => setTimeout(r, 80));
    expect(engine().loads).toEqual(["boot.wav"]);
    end();
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "neon.wav"]));
    expect(engine().handOffs).toEqual([]);
  });

  // Review #3: mid hand-off (slowed down, the next song decoding) the key says ▶ while
  // the old song still sounds. Pressing it means quiet — not a second decode.
  it("pressing the main key mid hand-off quiets the old song and holds the next at its start", async () => {
    let open!: () => void;
    mount();
    await startSet();
    h.loadGate = new Promise<void>((r) => (open = r));
    at(195.5);
    await waitFor(() => expect(engine().handOffs).toEqual(["boot.wav"]));
    fireEvent.click(screen.getByRole("button", { name: "เล่น" }));
    expect(engine().tailsStopped).toBe(2); // the set's first load, then this press
    open();
    await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "neon.wav"]));
    await new Promise((r) => setTimeout(r, 30));
    expect(engine().playing).toBe(false); // waiting at its start for ▶
  });

  it("a hold never carries over to a later song", async () => {
    let open!: () => void;
    mount();
    await startSet();
    h.loadGate = new Promise<void>((r) => (open = r));
    at(195.5);
    await waitFor(() => expect(engine().handOffs).toEqual(["boot.wav"]));
    fireEvent.click(screen.getByRole("button", { name: "เล่น" }));
    // a song picked by hand while that load is still out takes over…
    fireEvent.click(screen.getByRole("button", { name: /Transmission Failure/ }));
    open();
    await waitFor(() => expect(engine().loads).toContain("other.wav"));
    await waitFor(() => expect(engine().playing).toBe(true)); // …and plays
  });

  // 2026-10-07 review: the next song's file can still be on its way at the overlap's
  // moment (a big master on slow wifi). What is pressed in that wait has to stand.
  describe("while the next song is still being read", () => {
    let release!: () => void;
    beforeEach(() => {
      blob.special.set(
        "neon.wav",
        () => new Promise((r) => (release = () => r({ path: "neon.wav" })))
      );
    });

    it("a pause stands: the old song is not handed over, the next waits at its start", async () => {
      mount();
      await startSet();
      at(195.5);
      await new Promise((r) => setTimeout(r, 30)); // the overlap fired; its read is out
      fireEvent.click(screen.getByRole("button", { name: "หยุดชั่วคราว" }));
      expect(engine().playing).toBe(false);
      release();
      await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "neon.wav"]));
      await new Promise((r) => setTimeout(r, 30));
      expect(engine().handOffs).toEqual([]);
      expect(engine().playing).toBe(false);
    });

    it("an old song taken back to its start (⏮) is replaced, not left sounding under the next", async () => {
      mount();
      await startSet();
      at(195.5);
      await new Promise((r) => setTimeout(r, 30));
      at(0.4); // ⏮ → seek(0), still playing
      release();
      await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "neon.wav"]));
      expect(engine().handOffs).toEqual([]);
      await waitFor(() => expect(engine().playing).toBe(true)); // the set goes on
    });

    it("▶ on an old song that ended meanwhile plays the next - it never restarts the old one", async () => {
      mount();
      await startSet();
      at(195.5);
      await new Promise((r) => setTimeout(r, 30));
      act(() => {
        engine().playing = false; // boot reached its end
        engine().onPlayingChange(false);
      });
      fireEvent.click(screen.getByRole("button", { name: "เล่น" }));
      expect(engine().toggles).toBe(0);
      release();
      await waitFor(() => expect(engine().loads).toEqual(["boot.wav", "neon.wav"]));
      await waitFor(() => expect(engine().playing).toBe(true));
      expect(engine().handOffs).toEqual([]);
    });
  });
});
