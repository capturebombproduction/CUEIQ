// The native bridge the Electron preload exposes (desktop/electron/preload.cjs).
//
// Declared at the repo root (so it's part of BOTH builds): the web build now
// feature-detects `window.cueiqNative` in the Library to surface the desktop-only
// per-device local-source controls, and the desktop SPA uses the same bridge for
// CORS-free R2 transfers + the native file picker. Present only under Electron;
// undefined in a plain browser, hence optional.
interface CueiqNative {
  isElectron: true;
  fetchAudio: (url: string) => Promise<ArrayBuffer>;
  putAudio: (url: string, bytes: Uint8Array, contentType?: string) => Promise<void>;
  pickAudioFile: () => Promise<{ name: string; bytes: Uint8Array } | null>;
}

interface Window {
  cueiqNative?: CueiqNative;
}
