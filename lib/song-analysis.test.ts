// lib/song-analysis.ts - the numbers Live will show as "ดังกว่า +3.1 dB" and draw as the NOW
// card's waveform. Loudness is checked against EBU Tech 3341's own test signals (a meter that
// passes them is an R128 meter), and against libebur128 through ffmpeg on 2026-10-03: a 25 s
// stereo pink-noise + 220 Hz mix that ffmpeg's ebur128 filter put at -30.1 LUFS read -30.1 here.
import { describe, it, expect } from "vitest";
import {
  integratedLufs,
  encodeWaveform,
  decodeWaveform,
  WAVEFORM_FLOOR_DB,
  analyzeChannels,
  analyzeAudioBuffer,
  PEAK_POINTS,
} from "./song-analysis";

/** A 1 kHz sine whose PEAK is `dbfs` (EBU 3341's "-23 dBFS sine"), `seconds` long. */
function sine(dbfs: number, seconds: number, rate = 48000, hz = 1000): Float32Array {
  const a = Math.pow(10, dbfs / 20);
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = a * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe("integratedLufs (ITU-R BS.1770-4 / EBU R128)", () => {
  it("EBU 3341 case 1 and 2: a stereo 1 kHz sine at -23 / -33 dBFS reads -23.0 / -33.0", () => {
    const s23 = sine(-23, 20);
    expect(integratedLufs([s23, s23], 48000)).toBeCloseTo(-23, 1);
    const s33 = sine(-33, 20);
    expect(integratedLufs([s33, s33], 48000)).toBeCloseTo(-33, 1);
  });

  it("is designed for the file's own rate: the same sine at 44.1 kHz still reads -23.0", () => {
    const s = sine(-23, 20, 44100);
    expect(integratedLufs([s, s], 44100)).toBeCloseTo(-23, 1);
  });

  it("EBU 3341 case 3: quiet passages fall under the relative gate (-36 / -23 / -36 reads -23.0)", () => {
    const s = concat(sine(-36, 3), sine(-23, 20), sine(-36, 3));
    const v = integratedLufs([s, s], 48000)!;
    // EBU allows +-0.1 LU; 20 s of -23 (EBU uses 60) lets the edge blocks pull it to -22.9
    expect(Math.abs(v + 23)).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it("mono counts once, not twice: one channel of the -23 sine reads 3 LU lower", () => {
    const s = sine(-23, 20);
    expect(integratedLufs([s], 48000)).toBeCloseTo(-26, 0);
  });

  it("says nothing rather than something wrong: silence, and a file shorter than one block", () => {
    const silence = new Float32Array(48000 * 5);
    expect(integratedLufs([silence, silence], 48000)).toBeNull();
    const blip = sine(-10, 0.2);
    expect(integratedLufs([blip, blip], 48000)).toBeNull();
    expect(integratedLufs([], 48000)).toBeNull();
  });
});

describe("the waveform overview (stored in songs.peaks)", () => {
  it("is PEAK_POINTS base64url characters: each block's RMS level, -42..0 dBFS as 0..1", () => {
    // ten one-second blocks rising 4 dB at a time (-42 .. -6 dBFS peak), then silence
    const parts: Float32Array[] = [];
    for (let k = 0; k < 10; k++) parts.push(sine(-42 + 4 * k, 1));
    parts.push(new Float32Array(48000 * 10));
    const s = concat(...parts);
    const enc = encodeWaveform([s, s]);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(enc.length).toBe(PEAK_POINTS);
    const dec = decodeWaveform(enc);
    expect(dec.length).toBe(PEAK_POINTS);
    // a sine's RMS is 3 dB under its peak: the -6 dBFS block reads -9 dB RMS = (42-9)/42
    expect(dec[95]).toBeCloseTo((-WAVEFORM_FLOOR_DB - 9) / -WAVEFORM_FLOOR_DB, 1);
    expect(dec[2]).toBe(0); // -45 dB RMS is under the floor: flat
    expect(dec[PEAK_POINTS - 1]).toBe(0); // the silent tail is flat
    // a louder block never draws lower - the picture follows the music
    for (let i = 1; i < 100; i++) expect(dec[i] + 0.02).toBeGreaterThanOrEqual(dec[i - 1]);
  });

  it("still shows the sections of a loud, brick-walled master (why it is RMS, not peak)", () => {
    // a verse and a chorus that both clip at full scale, the chorus denser: same peak, more RMS
    const verse = sine(0, 4, 48000, 1000).map((v, i) => (i % 4 === 0 ? v : v * 0.3));
    const chorus = sine(0, 4);
    const dec = decodeWaveform(encodeWaveform([concat(verse, chorus), concat(verse, chorus)]));
    expect(dec[150] - dec[50]).toBeGreaterThan(0.1); // ~5 dB more RMS = a tenth of the height
  });

  it("only draws what is a waveform: anything else decodes to nothing", () => {
    expect(decodeWaveform(null)).toEqual([]);
    expect(decodeWaveform("")).toEqual([]);
    expect(decodeWaveform("short")).toEqual([]);
    expect(decodeWaveform("<script>alert(1)</script>-----")).toEqual([]);
  });
});

describe("analyzeChannels / analyzeAudioBuffer", () => {
  const s = sine(-23, 20);
  const buffer = { sampleRate: 48000, length: s.length, numberOfChannels: 2, getChannelData: () => s };

  it("returns what migration 0045 stores", () => {
    const a = analyzeChannels([s, s], 48000);
    expect(a.lufs).toBeCloseTo(-23, 1);
    expect(a.peaks).toHaveLength(PEAK_POINTS);
  });

  it("takes the first tracked beat as the offset, and survives a tracker that fails", async () => {
    const withBeat = await analyzeAudioBuffer(buffer, async () => ({ bpm: 128, beats: [0.4688, 0.9375] }));
    expect(withBeat).toMatchObject({ bpm: 128, beatOffset: 0.469 });
    const lost = await analyzeAudioBuffer(buffer, async () => ({ bpm: 120, beats: [] }));
    expect(lost).toMatchObject({ bpm: 120, beatOffset: null });
    const broken = await analyzeAudioBuffer(buffer, async () => {
      throw new Error("decoder hiccup");
    });
    expect(broken).toMatchObject({ bpm: null, beatOffset: null });
    expect(broken.lufs).toBeCloseTo(-23, 1);
  });
});
