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
});
