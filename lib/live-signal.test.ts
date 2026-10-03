// lib/live-signal.ts - the decisions behind Live's Signal strip. The tap itself needs Chromium
// (it runs in the desktop smoke); what it DECIDES is here: when a playing show is silent or
// frozen enough to put a red band on the operator's screen, and when an output is the
// computer's own speaker. A false alarm mid-show teaches people to ignore the real one, so
// most cases below are "must NOT alarm".
import { describe, it, expect } from "vitest";
import {
  toDb,
  meterPos,
  blockLevels,
  stepSilence,
  initialSilence,
  classifyOutput,
  outputLabel,
  SILENCE_ALARM_MS,
  START_GRACE_MS,
  type SilenceInput,
  type SilenceState,
  type SilenceVerdict,
} from "./live-signal";

describe("levels", () => {
  it("dBFS and the meter's 0..1 position (-48..0 dBFS)", () => {
    expect(toDb(1)).toBe(0);
    expect(toDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(toDb(0)).toBe(-Infinity);
    expect(meterPos(1)).toBe(1);
    expect(meterPos(Math.pow(10, -24 / 20))).toBeCloseTo(0.5, 5);
    expect(meterPos(0.0001)).toBe(0); // -80 dB is under the floor
    expect(meterPos(0)).toBe(0);
  });

  it("RMS and peak of a block", () => {
    const sq = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    expect(blockLevels(sq)).toEqual({ rms: 0.5, peak: 0.5 });
    expect(blockLevels(new Float32Array([0, -1, 0, 0])).peak).toBe(1);
    expect(blockLevels(new Float32Array(0))).toEqual({ rms: 0, peak: 0 });
  });
});

/** Drive the watch through a timeline; returns the verdict at each step. */
function run(steps: Array<Partial<SilenceInput> & { at: number }>, base?: Partial<SilenceInput>) {
  let s: SilenceState = initialSilence();
  const out: SilenceVerdict[] = [];
  let t = 30; // the player's position, advancing in real time unless a step says otherwise
  let prevAt = 0;
  for (const step of steps) {
    t += (step.at - prevAt) / 1000;
    prevAt = step.at;
    const input: SilenceInput = {
      now: step.at,
      playing: true,
      trackKey: "item-1",
      tapReady: true,
      rms: 0.1,
      currentTime: t,
      duration: 240,
      expectedQuiet: false,
      ...base,
      ...step,
    };
    if (step.currentTime !== undefined) t = step.currentTime;
    const r = stepSilence(s, input);
    s = r.state;
    out.push(r.verdict);
  }
  return out;
}
const every = (from: number, to: number, ms: number, extra: Partial<SilenceInput> = {}) => {
  const steps: Array<Partial<SilenceInput> & { at: number }> = [];
  for (let at = from; at <= to; at += ms) steps.push({ at, ...extra });
  return steps;
};

describe("NO SIGNAL: when a playing show is really silent", () => {
  it("a playing file that goes silent alarms after SILENCE_ALARM_MS - and not a frame sooner", () => {
    const v = run([...every(0, 3000, 100), ...every(3100, 3100 + SILENCE_ALARM_MS + 200, 100, { rms: 0 })]);
    const firstAlarm = v.indexOf("silent");
    // silence starts at 3100 ms; the alarm lands once it has lasted SILENCE_ALARM_MS
    expect(firstAlarm).toBeGreaterThan(0);
    expect(3100 + (firstAlarm - every(0, 3000, 100).length) * 100).toBeGreaterThanOrEqual(3100 + SILENCE_ALARM_MS);
  });

  it("clears the moment sound returns", () => {
    const v = run([...every(0, 7000, 100, { rms: 0 }), { at: 7100 }]);
    expect(v[v.length - 2]).toBe("silent");
    expect(v[v.length - 1]).toBeNull();
  });

  it("a frozen playhead while 'playing' is its own alarm (a stall), even with level", () => {
    const steps = every(0, 7000, 100).map((s) => ({ ...s, currentTime: s.at < 2000 ? 30 + s.at / 1000 : 32 }));
    const v = run(steps);
    expect(v).toContain("frozen");
  });
});

describe("NO SIGNAL: the false alarms it must never raise", () => {
  it("not while paused, and not when this device is not the one sounding", () => {
    expect(run(every(0, 10000, 100, { rms: 0, playing: false }))).not.toContain("silent");
  });

  it("not before the tap runs (a suspended AudioContext reads zeros)", () => {
    expect(run(every(0, 10000, 100, { rms: 0, tapReady: false }))).not.toContain("silent");
  });

  it("not in a track's first START_GRACE_MS - even if it starts silent", () => {
    const v = run(every(0, START_GRACE_MS + SILENCE_ALARM_MS - 600, 100, { rms: 0 }));
    // silence from 0, but the grace holds the verdict until START_GRACE_MS has passed AND
    // SILENCE_ALARM_MS of silence has accrued - the larger of the two
    expect(v.slice(0, Math.floor(Math.max(START_GRACE_MS, SILENCE_ALARM_MS) / 100))).not.toContain("silent");
  });

  it("a new track restarts the grace (the previous song's silence does not carry over)", () => {
    const v = run([
      ...every(0, 2900, 100, { rms: 0 }),
      ...every(3000, 3000 + START_GRACE_MS - 100, 100, { rms: 0, trackKey: "item-2" }),
    ]);
    expect(v).not.toContain("silent");
  });

  it("not where the song itself is quiet (its own waveform says so)", () => {
    expect(run(every(0, 10000, 100, { rms: 0, expectedQuiet: true }))).not.toContain("silent");
  });

  it("not in a track's last seconds (a fade-out is the song)", () => {
    const v = run(every(0, 10000, 100, { rms: 0, duration: 32 })); // 30 s in, 2 s left
    expect(v).not.toContain("silent");
    expect(v).not.toContain("frozen");
  });
});

describe("output device", () => {
  it("names the computer's own speaker on macOS and Windows", () => {
    expect(classifyOutput("MacBook Pro Speakers")).toBe("builtin");
    expect(classifyOutput("Default - MacBook Air Speakers")).toBe("builtin");
    expect(classifyOutput("Built-in Output")).toBe("builtin");
    expect(classifyOutput("Speakers (Realtek(R) Audio)")).toBe("builtin");
    expect(classifyOutput("Speakers (Intel® Smart Sound Technology for MIPI SoundWire® Audio)")).toBe("builtin");
  });

  it("never calls the PA feed a built-in speaker: jack, USB, interfaces, HDMI, Bluetooth", () => {
    expect(classifyOutput("External Headphones")).toBe("external");
    expect(classifyOutput("Headphones (Realtek(R) Audio)")).toBe("external");
    expect(classifyOutput("Speakers (USB Audio CODEC)")).toBe("external");
    expect(classifyOutput("Scarlett 2i2 USB")).toBe("external");
    expect(classifyOutput("LG HDR 4K (HDMI)")).toBe("external");
    expect(classifyOutput("AirPods Pro")).toBe("external");
    expect(classifyOutput("")).toBe("unknown");
    expect(classifyOutput(null)).toBe("unknown");
  });

  it("labels the chosen device, else the system default (without 'Default - ')", () => {
    const devs = [
      { deviceId: "default", label: "Default - MacBook Pro Speakers (Built-in)" },
      { deviceId: "abc", label: "USB Audio CODEC" },
    ];
    expect(outputLabel("abc", devs)).toBe("USB Audio CODEC");
    expect(outputLabel("", devs)).toBe("MacBook Pro Speakers (Built-in)");
    expect(outputLabel("gone", devs)).toBeNull();
    expect(outputLabel("", [])).toBeNull();
  });
});
