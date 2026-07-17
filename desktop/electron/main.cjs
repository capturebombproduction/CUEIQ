// CueIQ Desktop — Electron main process.
//
// Loads the built Vite SPA from DISK (no dev server, no service worker) so the app
// cold-boots offline. The renderer keeps using the same Supabase + R2 backend; the
// only thing main does for it is move audio BYTES (R2 presigned URLs travel over
// Node's net.fetch here, which is NOT subject to browser CORS — the desktop origin
// never has to be whitelisted on the R2 bucket) and open the native file picker for
// local-file ingest. Auth stays in the renderer: main only ever sees a presigned
// URL the renderer already minted, so no R2/Supabase secret is bundled in the app.
const { app, BrowserWindow, ipcMain, dialog, net, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

// Single instance ONLY: two instances would share the same userData profile, and
// Chromium's LevelDB (localStorage session + every offline IndexedDB store — mgmt
// outbox, song cache, Quick Show) is not safe under concurrent access. A second
// launch (impatient double-double-click at a venue) just focuses the running window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

const DEV_URL = process.env.CUEIQ_ELECTRON_DEV_URL || ""; // e.g. http://localhost:5273
const SMOKE = process.env.CUEIQ_SMOKE === "1"; // headless launch self-test
const INDEX_HTML = path.join(__dirname, "..", "dist", "index.html");

/** The audio proxy exists solely to move presigned R2 (https) URLs past browser
 * CORS — refuse anything else so it can never be steered at file:// or app IPC. */
function assertHttpsUrl(url) {
  if (new URL(url).protocol !== "https:") throw new Error("blocked non-https URL");
}

/** GET a presigned R2 URL's bytes in the main process (no CORS). */
async function fetchAudioBytes(url) {
  assertHttpsUrl(url);
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  // An ArrayBuffer rides Electron's structured-clone IPC as a transferable (not
  // JSON), and is a valid BlobPart on the renderer side.
  return res.arrayBuffer();
}

/** PUT bytes to a presigned R2 URL in the main process (no CORS). */
async function putAudioBytes(url, bytes, contentType) {
  assertHttpsUrl(url);
  const res = await net.fetch(url, {
    method: "PUT",
    body: Buffer.from(bytes),
    headers: contentType ? { "Content-Type": contentType } : undefined,
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
}

/** Native open dialog for picking a LOCAL audio file off the device. */
async function pickAudioFile() {
  const r = await dialog.showOpenDialog({
    title: "เลือกไฟล์เพลงจากเครื่อง",
    properties: ["openFile"],
    filters: [
      { name: "Audio", extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg", "aiff", "aif"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  const filePath = r.filePaths[0];
  const bytes = new Uint8Array(fs.readFileSync(filePath));
  return { name: path.basename(filePath), bytes };
}

function registerIpc() {
  ipcMain.handle("cueiq:fetch-audio", (_e, url) => fetchAudioBytes(url));
  ipcMain.handle("cueiq:put-audio", (_e, url, bytes, contentType) =>
    putAudioBytes(url, bytes, contentType)
  );
  ipcMain.handle("cueiq:pick-audio-file", () => pickAudioFile());
}

/**
 * Check GitHub Releases for a newer build and, if found, download it in the
 * background and install it on the NEXT quit — so an update can NEVER interrupt a
 * running show. Wired to the "publish: github" config in package.json.
 *
 * Gated to a packaged WINDOWS build on purpose:
 *   • dev / unpacked (`!app.isPackaged`) has nothing to update;
 *   • macOS auto-update needs a signed app (Squirrel.Mac) and we ship UNSIGNED,
 *     so it would only ever error — Mac users re-download the .dmg manually.
 * Every failure is swallowed: a flaky network or missing release must not delay
 * or break app start (this is the zero-tolerance live path's host).
 */
function initAutoUpdate() {
  if (!app.isPackaged || DEV_URL || SMOKE || process.platform !== "win32") return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return; // dependency not bundled — never block startup
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (err) => console.log("AUTOUPDATE_ERROR " + String(err)));
  autoUpdater
    .checkForUpdatesAndNotify()
    .catch((e) => console.log("AUTOUPDATE_CHECK_FAIL " + String(e)));
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#0b1220", // matches the dark theme so there's no white flash
    show: !SMOKE,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // We dodge CORS via the main process, NOT by weakening the renderer.
      webSecurity: true,
    },
  });

  // Open target=_blank / external links in the system browser, not a new window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // The window must NEVER navigate away from the SPA (a stray file drop or a
  // non-_blank link would otherwise replace the app with a bare Chromium page that
  // still carries the cueiqNative preload bridge). Allow only reloads of the app's
  // own document; hash routing is in-page and never hits will-navigate.
  const appUrl = DEV_URL || pathToFileURL(INDEX_HTML).href;
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(appUrl)) event.preventDefault();
  });

  // Live Mode + Quick Show arm a `beforeunload` guard while a show is running. In a
  // BROWSER that shows the native leave-confirm; in Electron it silently VETOES the
  // close instead — the ❌ button looks dead mid-show. Surface the choice natively:
  // ask, and if the user says leave, preventDefault() (which here means "ignore the
  // beforeunload veto and let the window close/reload proceed").
  win.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["อยู่ต่อ (โชว์รันอยู่)", "ออกเลย"],
      defaultId: 0,
      cancelId: 0,
      title: "CueIQ",
      message: "โชว์กำลังดำเนินอยู่",
      detail:
        "ปิดตอนนี้เสียงจะหยุดทันที — เวลา/ตำแหน่งโชว์ถูกเก็บไว้ กลับเข้ามาต่อได้ภายใน 6 ชั่วโมง",
    });
    if (choice === 1) event.preventDefault();
  });

  if (DEV_URL) {
    await win.loadURL(DEV_URL);
  } else {
    await win.loadFile(INDEX_HTML);
  }

  if (SMOKE) {
    // Headless self-test: confirm the renderer actually booted from disk.
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const info = await win.webContents.executeJavaScript(
        "JSON.stringify({ title: document.title, hash: location.hash, len: document.body.innerText.length, hasRoot: !!document.getElementById('root')?.children.length })"
      );
      console.log("SMOKE_RESULT " + info);
    } catch (e) {
      console.log("SMOKE_ERROR " + String(e));
    } finally {
      app.quit();
    }
  }
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  initAutoUpdate();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
