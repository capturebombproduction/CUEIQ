// Live's countdown around the "เข้าใน 5 4 3 2 1" count: a LOOP row's clock after MANUAL -> AUTO and
// after a tap back on it, and an AUTO row change that must never flash the OVERTIME plate.
// Found by the 2026-10-25 bug hunt (six reviewers, each finding proven by a test that failed on
// a003fe0), kept as the regression suite for what it found. Harness as components/event/live-mode.test.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import {
  makeSupabaseFake,
  instrumentMediaElements,
  makeSession,
  ok,
  type SupabaseFake,
  type ChannelFake,
} from "@/test/fakes/supabase";
import { liveTopic } from "@/lib/realtime";
import type { SetlistItem } from "@/lib/types";

const h = vi.hoisted(() => ({
  supa: null as unknown,
  saved: [] as Array<{ itemId: string; blob: Blob; name: string; path: string | null }>,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/audio-store", () => ({
  saveAudio: vi.fn(async () => {}),
  loadAudioForEvent: vi.fn(async () => h.saved),
  deleteAudio: vi.fn(async () => {}),
}));

import { LiveMode } from "@/components/event/live-mode";

const EVENT_ID = "11111111-2222-4333-8444-555555555555";
const GROUP_ID = "66666666-7777-4888-8999-000000000000";
const TOPIC = liveTopic(EVENT_ID);

function makeItem(n: number, over: Partial<SetlistItem> = {}): SetlistItem {
  return {
    id: `item-${n}`,
    tenant_id: "tenant-1",
    event_id: EVENT_ID,
    kind: "song",
    title: `Track ${n}`,
    duration_seconds: 240,
    buffer_before_seconds: 0,
    buffer_after_seconds: 0,
    mic_slots: [],
    notes: null,
    sort_order: n,
    song_id: null,
    audio_path: null,
    audio_name: null,
    loop_audio: false,
    ...over,
  };
}

let supa: SupabaseFake;

function useItems(items: SetlistItem[]) {
  supa = makeSupabaseFake({
    session: makeSession(),
    script: { setlist_items: ok(items), songs: ok([]), show_authority: ok([]) },
  });
  h.supa = supa;
}

async function mountLive(items: SetlistItem[]) {
  const view = render(
    <LiveMode
      eventId={EVENT_ID}
      groupId={GROUP_ID}
      eventName="Pads"
      items={items}
      songAudio={{}}
      canEdit={true}
      lastRunSeconds={null}
      lastRunAt={null}
    />
  );
  await act(async () => {});
  return view;
}
function live(): ChannelFake {
  const ch = supa.channelFor(TOPIC);
  if (!ch) throw new Error("no channel");
  return ch;
}
const stateSends = () => live().sent.filter((s) => s.event === "state");
async function startShowFromUi() {
  await act(async () => {
    live().setStatus("SUBSCRIBED");
  });
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("start-show"));
  });
}
const nowCard = () => document.querySelector<HTMLElement>("section[data-zone]")!;
const nowTimer = () => nowCard().querySelector('[role="timer"]')!.textContent;
const modeButton = (name: RegExp) => within(screen.getByRole("group", { name: "Show mode" })).getByRole("button", { name });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-08-08T20:00:00+07:00"));
  h.saved = [];
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LiveMode · a LOOP row's countdown follows its own clock, never its file", () => {
  it("an MC with a 60 s loop bed in a 3:00 slot, 1:30 in: AUTO keeps 1:30 left (not 2:30)", async () => {
    const items = [makeItem(1, { kind: "mc", title: "MC", loop_audio: true, duration_seconds: 180 }), makeItem(2), makeItem(3)];
    useItems(items);
    const media = instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["bgm"]), name: "bgm.wav", path: null }];
    await mountLive(items);
    await startShowFromUi(); // MANUAL (the default): START runs row 1 and its countdown
    await act(async () => {
      vi.advanceTimersByTime(90_000);
    });
    expect(nowTimer()).toBe("1:30");
    // the 60 s bed has gone round once: the element's own clock reads 0:30
    const primary = media.first()!;
    expect(media.state(primary).paused).toBe(false);
    primary.currentTime = 30;
    await act(async () => {
      fireEvent.click(modeButton(/^Auto$/));
    });
    expect(stateSends().at(-1)!.payload.mode).toBe("auto");
    // Before the 2026-10-25 fix: setMode takes offset = audio.currentTime (30), so the MC's
    // countdown jumps from 1:30 to 2:30 and Auto (and its 5 4 3 2 1) comes a minute late
    expect(nowTimer()).toBe("1:30");
  });

  it("MANUAL: cue the next row, then tap back on the sounding loop row: its countdown carries on", async () => {
    const items = [makeItem(1, { kind: "mc", title: "MC", loop_audio: true, duration_seconds: 180 }), makeItem(2), makeItem(3)];
    useItems(items);
    const media = instrumentMediaElements();
    h.saved = [{ itemId: "item-1", blob: new Blob(["bgm"]), name: "bgm.wav", path: null }];
    await mountLive(items);
    await startShowFromUi();
    await act(async () => {
      vi.advanceTimersByTime(90_000);
    });
    media.first()!.currentTime = 30;
    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowRight", code: "ArrowRight" }); // cue row 2
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowLeft", code: "ArrowLeft" }); // back to the sounding MC
    });
    expect(stateSends().at(-1)!.payload.currentIndex).toBe(0);
    // 91 s into the slot -> 1:29 left. Before the 2026-10-25 fix: 2:30 (anchored to the file's 0:30)
    expect(nowTimer()).toBe("1:29");
  });
});

// The count reads the big clock's number rounded UP (lib/time.ts clockSeconds) and Live wakes its
// clock on each whole second of the last six: a digit came on whichever 500 ms tick followed it -
// up to half a second off, and two devices on different tick phases read different digits.
describe("LiveMode · AUTO's 5 4 3 2 1 lands each digit on its whole second", () => {
  it("each digit first shows within a few ms of its whole second before the next row, off the 500 ms tick's phase", async () => {
    const items = [makeItem(1, { duration_seconds: 10 }), makeItem(2), makeItem(3)];
    useItems(items);
    instrumentMediaElements();
    await mountLive(items);
    await act(async () => {
      fireEvent.click(modeButton(/^Auto$/));
    });
    // the 500 ms tick then falls 230 ms off every whole second of the row
    await act(async () => {
      vi.advanceTimersByTime(230);
    });
    await startShowFromUi();
    const t0 = stateSends().find((m) => m.payload.begun)!.payload.itemStartedAt as number;
    await act(async () => {
      vi.advanceTimersByTime(t0 + 4_000 - Date.now());
    });
    const firstShown = new Map<number, number>();
    for (let ms = 0; ms < 6_000; ms += 10) {
      await act(async () => {
        vi.advanceTimersByTime(10);
      });
      const c = document.querySelector('[data-testid="now-entry-count"]')?.textContent;
      if (c && !firstShown.has(Number(c))) firstShown.set(Number(c), Date.now() - t0);
    }
    expect([...firstShown.keys()]).toEqual([5, 4, 3, 2, 1]);
    for (const [digit, at] of firstShown) {
      const beat = (10 - digit) * 1_000; // remaining = digit
      expect(at - beat).toBeGreaterThanOrEqual(0);
      expect(at - beat).toBeLessThanOrEqual(20);
    }
    // ...and the next row comes in on the beat after "1" (its wake is 5 ms past the moment)
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(stateSends().at(-1)!.payload.currentIndex).toBe(1);
  });
});

describe("LiveMode · an AUTO row change never shows the OVERTIME plate", () => {
  it("controller: the NOW card never commits data-zone=over (nor mounts the Overtime alert) at Auto's change", async () => {
    const items = [makeItem(1, { duration_seconds: 10 }), makeItem(2, { duration_seconds: 10 }), makeItem(3)];
    useItems(items);
    instrumentMediaElements();
    await mountLive(items);
    await act(async () => {
      fireEvent.click(modeButton(/^Auto$/)); // AUTO before START
    });
    await startShowFromUi();
    // every zone the NOW card's DOM takes, in commit order (oldValue of each change + the last)
    const zones: string[] = [];
    let alerts = 0;
    const mo = new MutationObserver((recs) => {
      for (const r of recs) {
        if (r.type === "attributes") zones.push(String(r.oldValue));
        for (const n of Array.from(r.addedNodes)) {
          if (n instanceof HTMLElement && n.getAttribute("role") === "alert" && /Overtime/.test(n.textContent ?? "")) alerts++;
        }
      }
    });
    mo.observe(document.body, { attributes: true, attributeFilter: ["data-zone"], attributeOldValue: true, subtree: true, childList: true });
    // as a browser runs it: each timer callback in its own task, each render committed
    for (let ms = 0; ms < 10_400; ms += 100) {
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
    }
    mo.disconnect();
    zones.push(nowCard().getAttribute("data-zone")!);
    expect(stateSends().at(-1)!.payload.currentIndex).toBe(1); // Auto moved on, as it should
    // Before the 2026-10-25 fix: ok -> warn -> urgent -> OVER -> ok; the Overtime header
    // (role=alert, a screen-reader announcement) mounted for that commit
    expect(zones).toEqual(["ok", "warn", "urgent", "ok"]);
    expect(alerts).toBe(0);
  });

  it("viewer: its clock at 0 before the controller's advance arrives holds 0:00, not OVERTIME", async () => {
    const items = [makeItem(1), makeItem(2), makeItem(3)];
    useItems(items);
    instrumentMediaElements();
    await mountLive(items);
    // the controller's last word, 40 ms on the wire: row 1 started 239.5 s ago (controller clock)
    const t = Date.now();
    await act(async () => {
      live().emit("state", {
        sender: "pa-device",
        sentAt: t - 40,
        fromController: true,
        begun: true,
        running: true,
        startedAt: t - 300_000,
        itemStartedAt: t - 40 - 239_500,
        itemElapsedAtPause: null,
        currentIndex: 0,
        currentItemId: "item-1",
        mode: "auto",
        controllerSince: t - 300_000,
        ended: false,
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(600); // controller hits 0 at +460 ms, its advance takes 150 ms more
    });
    // the viewer's tick at +500 ms: remaining = -0.04 s, the advance is still on the wire
    // Before the 2026-10-25 fix: the alarm plate ("Overtime · เกินเวลา") is up on the viewer
    expect(nowCard().getAttribute("data-zone")).not.toBe("over");
  });
});

// 2026-10-26: a row with no time (0:00) next. AUTO goes straight through it - its advance moves on
// the moment it starts - and the count named it, a title nobody hears, over the row that comes in.
describe("LiveMode · the count names the row AUTO lands on, past a 0:00 row", () => {
  it("Track 1 → a 0:00 row → Track 3: the count says Track 3, and Track 3 is where AUTO lands", async () => {
    const items = [
      makeItem(1, { duration_seconds: 10 }),
      makeItem(2, { kind: "mc", title: "Thank-you", duration_seconds: 0 }),
      makeItem(3),
    ];
    useItems(items);
    instrumentMediaElements();
    await mountLive(items);
    await act(async () => {
      fireEvent.click(modeButton(/^Auto$/));
    });
    await startShowFromUi();
    await act(async () => {
      vi.advanceTimersByTime(7_500);
    });
    const line = screen.getByTestId("now-entry");
    expect(line.textContent).toContain("Track 3");
    expect(line.textContent).not.toContain("Thank-you");
    // …and that is the row AUTO comes to
    for (let ms = 0; ms < 4_000; ms += 250) {
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
    }
    expect(stateSends().at(-1)!.payload.currentIndex).toBe(2);
  });

  it("(control) MANUAL with the same set: the static line names the row after this one, as before", async () => {
    const items = [
      makeItem(1, { duration_seconds: 10 }),
      makeItem(2, { kind: "mc", title: "Thank-you", duration_seconds: 0, buffer_before_seconds: -3 }),
      makeItem(3),
    ];
    useItems(items);
    instrumentMediaElements();
    await mountLive(items);
    await startShowFromUi();
    expect(screen.getByTestId("now-entry").textContent).toContain("Thank-you");
  });
});
