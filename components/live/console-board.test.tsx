// components/live/console-board.tsx - Live's CONSOLE board. It owns no show state: every
// readout comes from props and every key calls one of Live's own handlers. So the questions
// here are: does it SAY the right thing (the remaining time, the section, the next note, the
// next song's loudness, the trims), does each key call the handler STAGE's key calls with the
// same arguments, and does a locked board (a viewer, Auto) call nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { ConsoleBoard, type ConsoleItem } from "./console-board";
import type { SignalReading, SignalTap } from "@/lib/live-signal";

const PEAKS = "A".repeat(20) + "z".repeat(180); // quiet 10 %, then loud

function item(n: number, over: Partial<ConsoleItem> = {}): ConsoleItem {
  return {
    id: `item-${n}`,
    kind: "song",
    title: `Track ${n}`,
    block: 240,
    audioStart: 0,
    audioLen: 240,
    notes: null,
    songId: `song-${n}`,
    lufs: -14,
    peaks: PEAKS,
    bpm: 120,
    beatOffset: 0.5,
    ...over,
  };
}

const ITEMS = [
  item(1, { lufs: -11.2 }),
  item(2, { kind: "mc", title: "MC talk", songId: null, lufs: null, peaks: null, bpm: null, beatOffset: null, notes: "ไฟแดงเต็มเวที" }),
  item(3, { lufs: -17 }),
];

type Props = React.ComponentProps<typeof ConsoleBoard>;
function mount(over: Partial<Props> = {}) {
  const props: Props = {
    items: ITEMS,
    index: 0,
    elapsed: 30,
    remaining: 210,
    zone: "ok",
    running: true,
    endClock: "21:04:30",
    markers: { "song-1": [{ label: "INTRO", at: 0 }, { label: "VERSE", at: 20 }, { label: "CHORUS", at: 42 }] },
    playingId: "item-1",
    tap: null,
    player: () => null,
    volume: 80,
    onVolume: vi.fn(),
    onFade: vi.fn(),
    output: { label: "USB Audio CODEC", kind: "external" },
    soundOn: true,
    onOutput: vi.fn(),
    onCue: vi.fn(),
    nextLoudness: 3.1,
    ...over,
  };
  return { props, ...render(<ConsoleBoard {...props} />) };
}

let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => (frames.push(f), frames.length));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => vi.unstubAllGlobals());
const step = () => {
  const run = frames;
  frames = [];
  act(() => run.forEach((f) => f(performance.now())));
};

describe("the transport", () => {
  it("prints the item's clock, its place in the show, the section and when it ends", () => {
    mount();
    expect(screen.getByTestId("console-remain").textContent).toBe("3:30");
    const transport = screen.getByRole("group", { name: "Transport" });
    expect(transport.textContent).toContain("0:30 / 4:00");
    expect(transport.textContent).toContain("01 / 03");
    expect(transport.textContent).toContain("21:04");
    // the practice room's sections, in block time: VERSE now, CHORUS in 0:12
    expect(screen.getByTestId("console-section").textContent).toBe("VERSE → CHORUS 0:12");
  });

  it("overtime reads +m:ss, as the NOW card's countdown does", () => {
    mount({ elapsed: 252, remaining: -12, zone: "over" });
    expect(screen.getByTestId("console-remain").textContent).toBe("+0:12");
  });

  it("no markers, no section - a dash, never a guess", () => {
    mount({ markers: {} });
    expect(screen.getByTestId("console-section").textContent).toBe("—");
  });

  it("BAR.BEAT runs on the player's clock, only while the cued song is the one sounding", () => {
    const el = { currentTime: 4.6, paused: false, muted: false, volume: 1 } as HTMLMediaElement;
    const { rerender, props } = mount({ player: () => el });
    step();
    // 120 BPM, first beat at 0.5 s: 4.6 s is beat 8 → bar 3, beat 1
    expect(screen.getByTestId("console-barbeat").textContent).toBe("3.1");
    // the device sounds another item (Manual: cued ≠ sounding): no reading
    rerender(<ConsoleBoard {...props} player={() => el} playingId="item-3" />);
    step();
    expect(screen.getByTestId("console-barbeat").textContent).toBe("—");
  });

  it("the alarm band lies over the transport", () => {
    mount({ alarm: <div role="alert">No signal</div> });
    expect(screen.getByRole("alert").textContent).toBe("No signal");
  });
});

describe("the arrangement", () => {
  it("draws every item of a short show as a clip, and a clip cues its item", () => {
    const { props } = mount();
    const clips = screen.getAllByTestId("console-clip");
    expect(clips).toHaveLength(3);
    fireEvent.click(clips[2]);
    expect(props.onCue).toHaveBeenCalledWith(2);
  });

  it("locked (Auto, a viewer): the clips cue nothing", () => {
    mount({ onCue: null });
    const clips = screen.getAllByTestId("console-clip");
    expect(clips[2]).toBeDisabled();
  });

  it("the notes lane counts down to the next item's note", () => {
    mount();
    // item 2 starts at 4:00; the playhead is at 0:30 → in 3:30
    expect(screen.getByText(/ไฟแดงเต็มเวที · ใน 3:30/)).toBeTruthy();
  });
});

describe("the clip editor", () => {
  it("draws a measured song's waveform; says so for an unmeasured one or an item with no song", () => {
    const { unmount } = mount();
    expect(screen.getByTestId("console-wave")).toBeTruthy();
    unmount();
    mount({ items: [item(1, { peaks: null }), ...ITEMS.slice(1)] });
    expect(screen.getByText("ยังไม่ได้วัดรูปคลื่นของเพลงนี้")).toBeTruthy();
  });

  it("an item with no library song says it has none", () => {
    mount({ index: 1, elapsed: 10, remaining: 230 });
    expect(screen.getByText("รายการนี้ไม่ได้ผูกกับเพลงในคลัง")).toBeTruthy();
  });
});

describe("the set mixer", () => {
  it("shows each item's loudness and the trim only a too-loud SONG would take", () => {
    mount();
    const strips = screen.getAllByTestId("console-strip");
    expect(strips).toHaveLength(3);
    expect(strips[0].textContent).toContain("-11.2");
    expect(strips[0].textContent).toContain("−2.8"); // 2.8 dB down to −14
    expect(strips[1].textContent).toContain("—"); // MC: unmeasured
    expect(strips[2].textContent).toContain("-17.0");
    expect(strips[2].textContent).not.toContain("+"); // a quiet song is never raised
    expect(screen.getByLabelText("Set mixer").textContent).toContain("วัดแล้ว 2/3");
  });
});

describe("the playback channel", () => {
  it("MUTE / MC / LOUD call Live's fade with STAGE's targets and times", () => {
    const { props } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    fireEvent.click(screen.getByRole("button", { name: "MC" }));
    fireEvent.click(screen.getByRole("button", { name: "Loud" }));
    expect(props.onFade).toHaveBeenNthCalledWith(1, 0, 3000);
    expect(props.onFade).toHaveBeenNthCalledWith(2, 30, undefined);
    expect(props.onFade).toHaveBeenNthCalledWith(3, 100, 2500);
  });

  it("a viewer's fades and fader do nothing", () => {
    const { props } = mount({ onFade: null, onVolume: null });
    expect(screen.getByRole("button", { name: "Mute" })).toBeDisabled();
    const fader = screen.getByTestId("console-fader");
    expect(fader.getAttribute("aria-disabled")).toBe("true");
    expect(fader.tabIndex).toBe(-1);
    fireEvent.keyDown(fader, { key: "ArrowUp" });
    fireEvent.pointerDown(fader, { clientY: 0, pointerId: 1 });
    expect(props.onVolume).toBeNull();
  });

  it("the fader moves the track's volume with ↑ ↓ (Shift = 10), and leaves ← → to the show", () => {
    const onVolume = vi.fn();
    mount({ onVolume, volume: 80 });
    const fader = screen.getByRole("slider", { name: "ความดังของแทร็คนี้" });
    expect(fader.getAttribute("aria-valuenow")).toBe("80");
    fireEvent.keyDown(fader, { key: "ArrowUp" });
    fireEvent.keyDown(fader, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(fader, { key: "PageUp" });
    expect(onVolume.mock.calls).toEqual([[81], [70], [90]]);
    // ← and → are BACK and NEXT: the fader must not swallow them (nor Home / End)
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      fader.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(onVolume).toHaveBeenCalledTimes(3);
  });

  it("the fader stops at 0 and 100", () => {
    const onVolume = vi.fn();
    const { rerender, props } = mount({ onVolume, volume: 100 });
    fireEvent.keyDown(screen.getByTestId("console-fader"), { key: "PageUp" });
    rerender(<ConsoleBoard {...props} volume={3} />);
    fireEvent.keyDown(screen.getByTestId("console-fader"), { key: "ArrowDown", shiftKey: true });
    expect(onVolume.mock.calls).toEqual([[100], [0]]);
  });

  it("no file here (STAGE shows no fades either): no fader, and the fades are off", () => {
    mount({ volume: null });
    expect(screen.queryByTestId("console-fader")).toBeNull();
    expect(screen.getByText("ไม่มีไฟล์เสียงในรายการนี้")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Loud" })).toBeDisabled();
  });

  it("names the output, and the computer's own speaker turns the plate amber", () => {
    const { rerender, props } = mount();
    expect(screen.getByTestId("console-output").textContent).toBe("USB Audio CODEC");
    rerender(<ConsoleBoard {...props} output={{ label: "MacBook Pro Speakers", kind: "builtin" }} />);
    expect(screen.getByTestId("console-output").parentElement!.parentElement!.className).toContain("bg-warning");
    rerender(<ConsoleBoard {...props} soundOn={false} />);
    expect(screen.getByTestId("console-output").textContent).toBe("ปิดเสียงเครื่องนี้");
    fireEvent.click(screen.getByRole("button", { name: "เปลี่ยน" }));
    expect(props.onOutput).toHaveBeenCalled();
  });

  it("without a tap (the web build) the meters stand unlit and say where they work", () => {
    mount();
    expect(screen.getByText("มิเตอร์ทำงานในแอปเดสก์ท็อปเท่านั้น")).toBeTruthy();
    expect(screen.queryByTestId("console-peak")).toBeNull();
  });

  it("with a tap the loop reads it: the peak after the player's volume, the clip light", () => {
    let level = 0.5;
    const tap = {
      read: (): SignalReading => ({ ready: true, rmsL: level, rmsR: level, peakL: level, peakR: level }),
      startAnalysis: () => null,
    } as unknown as SignalTap;
    const el = { currentTime: 1, paused: false, muted: false, volume: 0.5 } as HTMLMediaElement;
    mount({ tap, player: () => el });
    step();
    // 0.5 × the player's 0.5 = 0.25 → −12.0 dBFS
    expect(screen.getByTestId("console-peak").textContent).toBe("-12.0");
    // and as data, for the desktop smoke
    expect(screen.getByTestId("console-channel").dataset.ready).toBe("1");
    expect(screen.getByTestId("console-channel").dataset.db).toBe("-12.0");
    expect(screen.getByTestId("console-clip-light").dataset.on).toBe("0");
    level = 1;
    el.volume = 1;
    step();
    expect(screen.getByTestId("console-clip-light").dataset.on).toBe("1");
  });
});

describe("the next channel", () => {
  it("says how much louder the next song is, and asks for the fader before it starts", () => {
    mount();
    const box = screen.getByTestId("console-next-loudness");
    expect(box.textContent).toContain("▲ +3.1 dB");
    expect(box.textContent).toContain("ดังกว่า");
    expect(within(screen.getByLabelText("Next channel")).getByText("MC talk")).toBeTruthy();
  });

  it("quieter, about the same, unmeasured, and the end of the show", () => {
    const { rerender, props } = mount({ nextLoudness: -2 });
    expect(screen.getByTestId("console-next-loudness").textContent).toContain("▼ −2.0 dB");
    rerender(<ConsoleBoard {...props} nextLoudness={0.4} />);
    expect(screen.getByTestId("console-next-loudness").textContent).toContain("≈ 0 dB");
    rerender(<ConsoleBoard {...props} nextLoudness={null} />);
    expect(screen.getByTestId("console-next-loudness").textContent).toBe("ยังไม่ได้วัดความดัง");
    rerender(<ConsoleBoard {...props} index={2} />);
    expect(screen.getByLabelText("Next channel").textContent).toContain("จบโชว์");
  });
});

describe("the bottom panel", () => {
  /** A tap whose analysis reads a steady −12 LUFS (z = 10^((−12 + 0.691) / 10)), peak 0.5. */
  function analysisTap() {
    const stop = vi.fn();
    const z = Math.pow(10, (-12 + 0.691) / 10);
    const frame = {
      sampleRate: 48000,
      bins: new Float32Array(4096).fill(-60),
      left: new Float32Array(2048).fill(0.1),
      right: new Float32Array(2048).fill(0.1),
      kMeanSquare: z,
      peak: 0.5,
    };
    const startAnalysis = vi.fn(() => ({ read: () => frame, stop }));
    const tap = {
      read: (): SignalReading => ({ ready: true, rmsL: 0.1, rmsR: 0.1, peakL: 0.1, peakR: 0.1 }),
      startAnalysis,
    } as unknown as SignalTap;
    return { tap, startAnalysis, stop };
  }
  beforeEach(() => localStorage.removeItem("cueiq:consoleTab"));

  it("the web build (no tap) has the SET MIXER alone", () => {
    mount();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Set mixer"]);
  });

  it("with a tap: ANALYZER first, and its readouts are the live loudness", () => {
    const { tap, startAnalysis } = analysisTap();
    mount({ tap });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Analyzer", "Set mixer", "Spectrogram"]);
    expect(screen.getByRole("tab", { name: "Analyzer" })).toHaveAttribute("aria-selected", "true");
    expect(startAnalysis).toHaveBeenCalledTimes(1);
    step();
    expect(screen.getByTestId("console-lufs-momentary").textContent).toBe("−12.0");
    expect(screen.getByTestId("console-lufs-integrated").textContent).toBe("−12.0");
  });

  it("a tab is kept per device; leaving the analysis tabs stops the analysis graph", () => {
    const { tap, startAnalysis, stop } = analysisTap();
    const { unmount } = mount({ tap });
    fireEvent.click(screen.getByRole("tab", { name: "Spectrogram" }));
    // analyzer -> spectrogram is the same analysis: not rebuilt
    expect(startAnalysis).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Set mixer" }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("cueiq:consoleTab")).toBe("mixer");
    expect(screen.getAllByTestId("console-strip")).toHaveLength(3);
    unmount();
    mount({ tap });
    expect(screen.getByRole("tab", { name: "Set mixer" })).toHaveAttribute("aria-selected", "true");
  });

  it("a new song starts the integrated loudness over; a pause does not", () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { tap, frame } = (() => {
      const t = analysisTap();
      return { tap: t.tap, frame: (t.tap.startAnalysis() as unknown as { read: () => { kMeanSquare: number } }).read() };
    })();
    const z = (lufs: number) => Math.pow(10, (lufs + 0.691) / 10);
    const at = (lufs: number) => {
      frame.kMeanSquare = z(lufs);
      clock += 200;
      step();
    };
    const { rerender, props } = mount({ tap });
    at(-6);
    at(-6);
    expect(screen.getByTestId("console-lufs-integrated").textContent).toBe("−6.0");
    // paused (Live keeps the item loaded): the song goes on, so does its value
    rerender(<ConsoleBoard {...props} tap={tap} running={false} />);
    at(-8);
    expect(screen.getByTestId("console-lufs-integrated").textContent).not.toBe("−8.0");
    // the next song: its own value from its first block
    rerender(<ConsoleBoard {...props} tap={tap} playingId="item-3" />);
    at(-20);
    expect(screen.getByTestId("console-lufs-integrated").textContent).toBe("−20.0");
  });
});
