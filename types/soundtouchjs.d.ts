// soundtouchjs ships no TypeScript types. This declares only the slice of the
// PitchShifter API that lib/practice-audio.ts uses. See node_modules/soundtouchjs
// (dist/soundtouch.js) for the source of truth.
//
// NOTE the asymmetry baked into the library: `percentagePlayed` GETTER returns
// 0..100, but the SETTER expects a 0..1 fraction. lib/practice-audio.ts only ever
// sets it (as `seconds / duration`), so the engine treats it as a fraction.
declare module "soundtouchjs" {
  export interface PitchShifterPlayDetail {
    timePlayed: number; // seconds of source audio consumed
    formattedTimePlayed: string;
    percentagePlayed: number; // 0..100
  }

  export class PitchShifter {
    constructor(
      context: BaseAudioContext,
      buffer: AudioBuffer,
      bufferSize: number,
      onEnd?: () => void
    );
    /** Time-stretch factor: <1 slower, >1 faster — pitch preserved. */
    tempo: number;
    rate: number;
    /** 1 = no shift (keep key). */
    pitch: number;
    pitchSemitones: number;
    /** Setter takes a 0..1 fraction; getter returns 0..100. */
    percentagePlayed: number;
    timePlayed: number;
    sourcePosition: number;
    readonly duration: number;
    readonly node: AudioNode;
    readonly formattedDuration: string;
    readonly formattedTimePlayed: string;
    connect(toNode: AudioNode): void;
    disconnect(): void;
    on(eventName: "play", cb: (detail: PitchShifterPlayDetail) => void): void;
    off(eventName?: string): void;
  }
}
