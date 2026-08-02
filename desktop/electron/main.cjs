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

/** Remembers the one version the operator said "ไว้ก่อน" to, so declining is not
 *  a decision they have to make again every single launch. */
const SKIP_FILE = () => path.join(app.getPath("userData"), "update-skip.json");

function readSkippedVersion() {
  try {
    return JSON.parse(fs.readFileSync(SKIP_FILE(), "utf8")).version || null;
  } catch {
    return null;
  }
}

function writeSkippedVersion(version) {
  try {
    fs.writeFileSync(SKIP_FILE(), JSON.stringify({ version }), "utf8");
  } catch {
    /* best-effort — worst case we ask again next launch */
  }
}

/**
 * Check GitHub Releases for a newer build and ASK before doing anything about it.
 * Wired to the "publish: github" config in package.json.
 *
 * พี่'s call (2026-08-02): ASK FIRST. The installer is ~107 MB and the check fires
 * at launch — which at a venue is the same minute the operator is setting up, on
 * the same phone hotspot Live Mode needs for realtime and for pulling audio off R2.
 * Downloading that unasked is the app competing with its own show. So: check
 * quietly, ask once, and only download if the answer is yes. Installing still
 * happens on QUIT and never mid-show.
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
  autoUpdater.autoDownload = false; // the whole point: ask first
  autoUpdater.autoInstallOnAppQuit = true; // …but once downloaded, install on quit
  autoUpdater.on("error", (err) => console.log("AUTOUPDATE_ERROR " + String(err)));

  autoUpdater.on("update-available", async (info) => {
    const version = info?.version ? String(info.version) : "";
    if (version && version === readSkippedVersion()) return; // already declined this one
    try {
      // NO parent window on purpose: a parented box is MODAL and disables the
      // window under it (this file relies on that at the exit confirm). The check
      // can resolve late on a slow venue hotspot, and a modal that lands over a
      // running show kills every click and every keyboard cue until someone finds
      // the mouse. Parentless, it is just a window the operator can ignore.
      const { response, checkboxChecked } = await dialog.showMessageBox({
        type: "question",
        buttons: ["โหลดเลย", "ไว้ก่อน"],
        defaultId: 0,
        cancelId: 1,
        title: "CueIQ มีเวอร์ชันใหม่",
        message: `มีเวอร์ชันใหม่${version ? ` (${version})` : ""}`,
        detail:
          "ไฟล์ประมาณ 100 MB — ถ้าอยู่หน้างานและใช้เน็ตมือถือ กด “ไว้ก่อน” ได้เลย\n" +
          "ถ้าโหลด จะติดตั้งให้ตอนปิดโปรแกรม ไม่รบกวนระหว่างโชว์",
        checkboxLabel: "ไม่ต้องถามเรื่องเวอร์ชันนี้อีก",
        checkboxChecked: false,
      });
      if (response === 0) {
        autoUpdater.downloadUpdate().catch((e) => console.log("AUTOUPDATE_DL_FAIL " + String(e)));
      } else if (checkboxChecked && version) {
        writeSkippedVersion(version);
      }
    } catch (e) {
      console.log("AUTOUPDATE_PROMPT_FAIL " + String(e));
    }
  });

  // Deliberately SILENT. A 107 MB download over venue wifi finishes minutes after
  // it was agreed to — which can easily be mid-show — and there is nothing for the
  // operator to do about it: autoInstallOnAppQuit already handles the rest. An
  // announcement here would be a dialog nobody asked for at the worst moment.
  autoUpdater.on("update-downloaded", (info) => {
    console.log("AUTOUPDATE_READY " + String(info?.version ?? ""));
  });

  autoUpdater
    .checkForUpdates()
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
  // Deliberately NOT awaited: the update prompt is parentless, so it needs no
  // window — and awaiting the page load would let a failed load take both the
  // updater and the activate handler down with it.
  createWindow();
  initAutoUpdate();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
