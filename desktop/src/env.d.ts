/// <reference types="vite/client" />
// Pull in the repo-root module declarations the reused lib needs (soundtouchjs
// ships no types — used by lib/practice-audio.ts, reused on the Training page).
/// <reference path="../../types/soundtouchjs.d.ts" />

// The native bridge the Electron preload exposes (see desktop/electron/preload.cjs).
// Present only under Electron; undefined in a plain browser (dev preview).
interface CueiqNative {
  isElectron: true;
  fetchAudio: (url: string) => Promise<ArrayBuffer>;
  putAudio: (url: string, bytes: Uint8Array, contentType?: string) => Promise<void>;
  pickAudioFile: () => Promise<{ name: string; bytes: Uint8Array } | null>;
}

interface Window {
  cueiqNative?: CueiqNative;
}
