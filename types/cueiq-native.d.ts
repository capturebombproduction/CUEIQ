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
  setShowRunning: (running: boolean) => Promise<void>;
  /** Which beforeunload guard is armed: a running show, an unsaved edit, or
   *  neither. Electron swaps the browser's leave-confirm for a native dialog whose
   *  wording lives in main.cjs, so it has to be told which one it is describing. */
  setUnloadReason: (reason: "show" | "unsaved" | null) => Promise<void>;
  /** The app's update state (desktop/electron/main.cjs). Optional: an older preload
   *  without it leaves the update chip simply absent. */
  updates?: CueiqUpdates;
}

interface CueiqUpdateState {
  state: "idle" | "unsupported" | "checking" | "uptodate" | "available" | "downloading" | "ready" | "error";
  current: string;
  latest: string | null;
  /** download progress 0-100 while "downloading" */
  percent: number | null;
  /** macOS only: this Mac's .dmg of the newer version */
  url: string | null;
  /** macOS only: true when the press can only open that .dmg (the app cannot replace
   *  itself here — see desktop/electron/main.cjs checkMacFeed); false = in-app update */
  manual?: boolean;
  platform: string;
}

interface CueiqUpdates {
  get: () => Promise<CueiqUpdateState>;
  check: () => Promise<CueiqUpdateState>;
  apply: () => Promise<CueiqUpdateState>;
  onChange: (cb: (state: CueiqUpdateState) => void) => () => void;
}

interface Window {
  cueiqNative?: CueiqNative;
}
