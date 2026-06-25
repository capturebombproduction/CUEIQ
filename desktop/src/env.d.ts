/// <reference types="vite/client" />

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
