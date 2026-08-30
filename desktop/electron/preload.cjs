// Preload bridge — the only surface the renderer can see of the main process.
// Exposes a tiny, audited API (contextIsolation ON) for the native operations the
// SPA can't do in a browser sandbox: move R2 audio bytes without CORS, and pick a
// local audio file. Everything else (auth, presign, UI) stays pure web in the SPA.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cueiqNative", {
  isElectron: true,
  // GET a presigned R2 URL's bytes via the main process (no browser CORS).
  fetchAudio: (url) => ipcRenderer.invoke("cueiq:fetch-audio", url),
  // PUT bytes to a presigned R2 URL via the main process (no browser CORS).
  putAudio: (url, bytes, contentType) =>
    ipcRenderer.invoke("cueiq:put-audio", url, bytes, contentType),
  // Native file picker → { name, bytes } | null.
  pickAudioFile: () => ipcRenderer.invoke("cueiq:pick-audio-file"),
  // Tell main a show has started/ended running, so it can hold the display awake
  // (electron powerSaveBlocker) for the duration — see desktop/electron/main.cjs.
  setShowRunning: (running) => ipcRenderer.invoke("cueiq:set-show-running", running),
  // Which beforeunload guard is armed right now: "show" | "unsaved" | null. In a
  // browser the guard's own text is shown; Electron replaces it with a native
  // dialog whose words are written in main.cjs, so main has to be told which
  // situation it is describing or it will say a show is running during an edit.
  setUnloadReason: (reason) => ipcRenderer.invoke("cueiq:set-unload-reason", reason),
});
