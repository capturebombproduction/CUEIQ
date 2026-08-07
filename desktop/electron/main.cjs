// CueIQ Desktop — Electron main process.
//
// Loads the built Vite SPA from DISK (no dev server, no service worker) so the app
// cold-boots offline. The renderer keeps using the same Supabase + R2 backend; the
// only thing main does for it is move audio BYTES (R2 presigned URLs travel over
// Node's net.fetch here, which is NOT subject to browser CORS — the desktop origin
// never has to be whitelisted on the R2 bucket) and open the native file picker for
// local-file ingest. Auth stays in the renderer: main only ever sees a presigned
// URL the renderer already minted, so no R2/Supabase secret is bundled in the app.
const { app, BrowserWindow, ipcMain, dialog, net, shell, powerSaveBlocker } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

// ⚠️ ORDERING: this block must stay ABOVE requestSingleInstanceLock and above every
// `app.whenReady()` path. Chromium reads command-line switches when the network
// service starts, and the instance lock is a file inside userData — a switch
// appended later is silently ignored, which is the quiet kind of wrong this whole
// self-test exists to stop. Killing DNS process-wide is the one layer that reaches
// the MAIN process's net.fetch as well as the renderer; the per-session layers in
// cutTheNetworkForSmoke cannot.
if (process.env.CUEIQ_SMOKE === "1" && process.env.CUEIQ_SMOKE_OFFLINE === "1") {
  app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");
}

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
// Where the self-test writes its verdict. stdout is NOT usable for this: electron
// is a GUI-subsystem binary on Windows, so a packaged .exe launched from CI has no
// console attached and every console.log vanishes. A file is the only channel that
// works on all three platforms — and CI asserting on a file it must find is also
// what turns "the app crashed on boot" into a failed build instead of silence.
const SMOKE_OUT = process.env.CUEIQ_SMOKE_OUT || "";
// ── The airplane test, run by a machine ──────────────────────────────────────
// The original self-test boots with NO ACCOUNT and the NETWORK UP, which is the
// exact opposite of the only condition that has ever cost us a show: a laptop
// cold-booting at a venue with no internet, hours after it was last online.
// (That condition is how the @supabase/ssr cookie bug reached พี่ — every query
// silently ran as anon under file://, and nothing in CI could have seen it.)
//
// Three env vars turn the same self-test into that condition:
//   CUEIQ_SMOKE_SEED_FILE  a JSON file of localStorage entries, planted BEFORE the
//                          app's own boot code runs (see plantSmokeSeed).
//   CUEIQ_SMOKE_OFFLINE=1  cut the network for the renderer AND the main process.
//   CUEIQ_SMOKE_EXPECT     "signed-in" | "signed-out" — what the boot must reach.
//                          Empty keeps the old "did anything render" behaviour.
const SMOKE_SEED_FILE = process.env.CUEIQ_SMOKE_SEED_FILE || "";
const SMOKE_OFFLINE = process.env.CUEIQ_SMOKE_OFFLINE === "1";
const SMOKE_EXPECT = process.env.CUEIQ_SMOKE_EXPECT || "";
// What the seeded cache should surface once it is read back. Kept as env rather
// than baked in here so main.cjs stays generic and the fixture owns its own values
// (desktop/scripts/make-smoke-seed.mjs exports both).
const SMOKE_EXPECT_TENANT = process.env.CUEIQ_SMOKE_EXPECT_TENANT || "";
const SMOKE_EXPECT_EVENTS = process.env.CUEIQ_SMOKE_EXPECT_EVENTS || "";
// Route to open on, without a hash (e.g. "/my-show"). The self-test has no input
// driver, so a scenario about a specific screen has to start there.
const SMOKE_HASH = process.env.CUEIQ_SMOKE_HASH || "";
const INDEX_HTML = path.join(__dirname, "..", "dist", "index.html");

// Every R2 S3-compatible endpoint lives under this suffix (lib/r2.ts builds it as
// `https://${accountId}.r2.cloudflarestorage.com`). The account id itself is a
// server-only secret (never shipped to the desktop bundle — see vite.config.ts,
// which injects the Supabase/web-origin config but nothing R2-shaped), so the
// exact host isn't available at build time; this suffix is the tightest check
// possible without it.
const R2_HOSTNAME_SUFFIX = ".r2.cloudflarestorage.com";

/** The audio proxy exists solely to move presigned R2 bytes past browser CORS.
 * Without a host pin this is an open proxy: window.cueiqNative.fetchAudio/putAudio
 * (preload.cjs) takes a bare URL from the renderer, so any injected renderer
 * script could GET or PUT an arbitrary https URL through the main process with no
 * CORS — silently exfiltrating the band's masters (or a session token pasted into
 * a "url"). Pin it to the one host every legitimate call ever targets. */
function assertR2Url(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("blocked non-https URL");
  if (!parsed.hostname.endsWith(R2_HOSTNAME_SUFFIX)) {
    throw new Error("blocked non-R2 host: " + parsed.hostname);
  }
}

/** The offline self-test cuts the RENDERER's network through the session (see
 *  cutTheNetworkForSmoke). This is the other half: the audio proxy runs in the main
 *  process on Node's net stack, so without this a "no network" boot could still
 *  reach R2 and the test would be proving the wrong machine's connectivity. */
function assertNotOfflineSmoke() {
  if (SMOKE_OFFLINE) throw new Error("offline smoke: the main-process network is cut");
}

/** GET a presigned R2 URL's bytes in the main process (no CORS). */
async function fetchAudioBytes(url) {
  assertNotOfflineSmoke();
  assertR2Url(url);
  // redirect: "error" — net.fetch follows redirects by default, and a redirect
  // is exactly how a pinned host could hand the request off to somewhere else.
  const res = await net.fetch(url, { redirect: "error" });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  // An ArrayBuffer rides Electron's structured-clone IPC as a transferable (not
  // JSON), and is a valid BlobPart on the renderer side.
  return res.arrayBuffer();
}

/** PUT bytes to a presigned R2 URL in the main process (no CORS). */
async function putAudioBytes(url, bytes, contentType) {
  assertNotOfflineSmoke();
  assertR2Url(url);
  const res = await net.fetch(url, {
    method: "PUT",
    body: Buffer.from(bytes),
    headers: contentType ? { "Content-Type": contentType } : undefined,
    redirect: "error", // see fetchAudioBytes — never let a redirect leave the pinned host
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

// The PA machine is the one thing at a venue nobody is looking at during a long
// no-audio gap (MC talk, set change) — Windows will happily sleep the display or
// suspend the system. The renderer already asks for navigator.wakeLock, but that's
// a browser-spec API riding a file:// origin Electron never promised to honor the
// same way a real tab does; this is the same protection enforced at the OS level,
// which is why it's worth having both. Idempotent both ways so callers don't have
// to track whether it's already on/off.
let powerSaveBlockerId = null;

function startShowPowerSaveBlocker() {
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) return;
  powerSaveBlockerId = powerSaveBlocker.start("prevent-display-sleep");
}

function stopShowPowerSaveBlocker() {
  if (powerSaveBlockerId === null) return;
  if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId);
  powerSaveBlockerId = null;
}

function registerIpc() {
  ipcMain.handle("cueiq:fetch-audio", (_e, url) => fetchAudioBytes(url));
  ipcMain.handle("cueiq:put-audio", (_e, url, bytes, contentType) =>
    putAudioBytes(url, bytes, contentType)
  );
  ipcMain.handle("cueiq:pick-audio-file", () => pickAudioFile());
  // Renderer tells us when a show starts/ends running; see the SPA's live paths.
  ipcMain.handle("cueiq:set-show-running", (_e, running) =>
    running ? startShowPowerSaveBlocker() : stopShowPowerSaveBlocker()
  );
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

// ─── self-test helpers (CUEIQ_SMOKE only) ────────────────────────────────────

/** Make "no network" real, and REPORTABLE.
 *
 *  Two layers on purpose. webRequest cancellation is the deterministic one — a
 *  cancelled request fails instantly, where emulated-offline can sit in Chromium's
 *  retry logic and turn a 20-second test into a 3-minute CI timeout — and it is
 *  also the only layer that can say WHAT the app tried to reach, which is the
 *  difference between "it booted" and "it booted without touching the network".
 *  enableNetworkEmulation backs it up for anything that never reaches webRequest.
 *  The main process's own net.fetch is cut separately (assertNotOfflineSmoke). */
function blockNetworkRequestsForSmoke(win, attempted) {
  const ses = win.webContents.session;
  // ⚠️ NEVER "<all_urls>" or "*://*/*" here: the app's own document and bundle are
  // file:// URLs, and cancelling those blanks the window — a test that then reports
  // "rendered nothing" for a reason that has nothing to do with the app.
  ses.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => {
      let host;
      try {
        host = new URL(details.url).host;
      } catch {
        host = String(details.url).slice(0, 80);
      }
      // Deduped and capped: supabase-js retries a failing refresh several times,
      // and an unbounded list would bloat the verdict file with one host repeated.
      if (host && !attempted.includes(host) && attempted.length < 25) attempted.push(host);
      callback({ cancel: true });
    }
  );
  ses.enableNetworkEmulation({ offline: true });
}

/** The layer that actually matters most, and the one the first cut of this missed.
 *
 *  NEITHER host-resolver-rules nor the two session-level blocks above flips
 *  `navigator.onLine` — and navigator.onLine is what the WHOLE APP keys on:
 *  cache.ts's isOffline() gates the cache-first branch in workspace.ts,
 *  events-list.ts, event-bundle.ts and run-order.ts, and it drives OfflineBanner.
 *  Without this an "airplane" smoke silently exercises the BLACK-HOLED-WIFI path
 *  instead: the app believes it is online, issues every read, and waits. Not
 *  hypothetical — that is exactly what the first run of this test did, and the hang
 *  it produced turned out to be a real unbounded await in
 *  desktop/src/data/workspace.ts. Network.emulateNetworkConditions is what DevTools'
 *  own Offline switch uses, and it does flip the flag.
 *
 *  ⚠️ MUST be called AFTER the first load. The debugger needs a live renderer to
 *  attach to; called before one exists it does not throw, it simply never answers —
 *  which showed up as a 90-second watchdog verdict with no cause attached. */
async function emulateOfflineViaCdp(win) {
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach("1.3");
  await dbg.sendCommand("Network.enable");
  await dbg.sendCommand("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  // …and the emulation DOES NOT SURVIVE THE RELOAD. Measured, not assumed: right
  // after the command above navigator.onLine is false, and after the seeding reload
  // it is true again — so the boot actually under test would run believing it is
  // online, which is the black-holed-wifi path wearing the airplane test's name.
  //
  // Page.addScriptToEvaluateOnNewDocument is the deterministic fix: Chromium runs it
  // before ANY script in each new document, so the app's very first read already
  // sees offline. Re-sending emulateNetworkConditions on did-finish-load would be a
  // race against the app's own boot effect — the 2am-flake shape.
  //
  // This patches the browser's SIGNAL, not its behaviour: the bytes are stopped by
  // host-resolver-rules, the webRequest blocker and the session emulation, and both
  // self-probes have to reject before the verdict can be ok. A real offline machine
  // reports exactly this, and cache.ts's isOffline() — which gates the cache-first
  // branch in workspace.ts, events-list.ts, event-bundle.ts and run-order.ts — is
  // the thing the whole test exists to exercise.
  await dbg.sendCommand("Page.enable");
  await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source:
      "Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });",
  });
}

/** Reload and wait for the new document. Shared by the seeding path (which must
 *  reload so the app's own boot code sees the planted storage) and by the unseeded
 *  offline path (which must reload so boot happens with navigator.onLine already
 *  false). */
function reloadAndWait(win, whatFor) {
  return new Promise((resolve, reject) => {
    const onLoaded = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      win.webContents.off("did-finish-load", onLoaded);
      reject(new Error(`the reload ${whatFor} never finished loading`));
    }, 20_000);
    win.webContents.once("did-finish-load", onLoaded);
    win.webContents.reload();
  });
}

/** The claim "the network was cut" has to be PROVEN, not configured — a cut that
 *  silently stopped working would turn this whole test green forever while proving
 *  nothing. Probe from both processes: the renderer has the webRequest blocker and
 *  the CDP emulation, the main process has neither and relies on the session-level
 *  emulation, so they can fail independently.
 *
 *  net.fetch DIRECTLY, not through fetchAudioBytes: that path would be refused by
 *  assertR2Url's host pin and would therefore "reject" just as convincingly with the
 *  network fully up. */
async function proveTheNetworkIsCut(win) {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://example.invalid") + "/auth/v1/health";
  const probe = async (run) => {
    try {
      await run();
      return "resolved"; // the cut leaked
    } catch {
      return "rejected"; // as intended
    }
  };
  return {
    main: await probe(() => net.fetch(url, { redirect: "error" })),
    renderer: await probe(() =>
      win.webContents.executeJavaScript(
        `fetch(${JSON.stringify(url)}, { cache: "no-store" }).then(() => "resolved")`
      )
    ),
  };
}

/** Plant localStorage entries so the app's own boot code reads them.
 *
 *  There is no API to write a renderer's localStorage from main, and file:// has
 *  no same-origin page to borrow — so the sequence is load, write, RELOAD. The
 *  first load's side effects (a Supabase client, an auth listener) die with the
 *  document; only the second boot is the one under test. That reload is also what
 *  makes this a genuine COLD boot against pre-existing storage, which is the state
 *  a laptop is actually in when it is opened at a venue. */
async function plantSmokeSeed(win) {
  const entries = JSON.parse(fs.readFileSync(SMOKE_SEED_FILE, "utf8"));
  // Handed over as a JSON string that the page parses, rather than inlined as a
  // JS object literal. Same result, one less way to break: a seed value is
  // arbitrary text, and inlining it makes the page's parser responsible for it.
  const payload = JSON.stringify(JSON.stringify(entries));
  const planted = await win.webContents.executeJavaScript(
    `(() => { const e = JSON.parse(${payload});
      for (const k of Object.keys(e)) window.localStorage.setItem(k, e[k]);
      return Object.keys(e).length; })()`
  );
  await reloadAndWait(win, "after seeding");
  return planted;
}

/** What the renderer is actually showing. Deliberately structural, not textual:
 *  the HashRouter's route and the presence of a password field say which screen
 *  the boot reached without pinning the test to any Thai string. */
const SMOKE_PROBE = `JSON.stringify({
  title: document.title,
  hash: location.hash,
  len: document.body.innerText.length,
  hasRoot: !!document.getElementById('root')?.children.length,
  loginVisible: !!document.querySelector('input[type=password]'),
  screen: document.querySelector('[data-cueiq-screen]')?.getAttribute('data-cueiq-screen') || null,
  tenantName: document.querySelector('[data-cueiq-tenant]')?.getAttribute('data-cueiq-tenant') || null,
  eventRows: Number(document.querySelector('[data-cueiq-events]')?.getAttribute('data-cueiq-events') ?? -1),
  onLine: navigator.onLine,
})`;

/** A screen the app has ARRIVED at, as opposed to one it is passing through. Only
 *  "boot" and "shell-fallback"'s loading half are transient, and polling has to
 *  keep going through them or the test samples a spinner and calls it an answer. */
const TERMINAL_SCREENS = ["login", "shell", "quick-show", "app-error"];

/** Did this boot land where it was told to? "" means the old, weaker question:
 *  did anything render at all. */
function smokeExpectationMet(p) {
  if (!p.hasRoot) return false;
  if (SMOKE_EXPECT === "signed-in") {
    // Three independent halves, because each alone has a way of being satisfied by
    // a failure: the router reached the authenticated tree (#/dashboard, not
    // #/login), the SHELL rendered rather than its fallback (signed in and showing
    // nothing is not the same as signed in and usable — that difference is one Thai
    // word on screen and a whole show in practice), and no password field is up.
    if (!(p.screen === "shell" && p.hash.startsWith("#/dashboard") && !p.loginVisible)) return false;
    // …and, when a cache was seeded, that the app actually READ it. An exact event
    // count, never "> 0": the cache key is derived from the account's viewable
    // groups, so a scope mismatch yields a perfectly healthy screen with no shows
    // on it, which is the failure a lower bound would wave through.
    if (SMOKE_EXPECT_TENANT && p.tenantName !== SMOKE_EXPECT_TENANT) return false;
    if (SMOKE_EXPECT_EVENTS && String(p.eventRows) !== SMOKE_EXPECT_EVENTS) return false;
    return true;
  }
  if (SMOKE_EXPECT === "signed-out") {
    return p.screen === "login" && p.hash.startsWith("#/login") && p.loginVisible;
  }
  if (SMOKE_EXPECT === "quick-show") {
    return p.screen === "quick-show";
  }
  return true;
}

/** Write the verdict and stop. Idempotent: whichever path gets here first wins, so
 *  a watchdog cannot overwrite a real answer and a real answer cannot be followed
 *  by a watchdog's.
 *
 *  Every failure mode in this file must funnel through here. "The packaged app
 *  never reported" is the single worst thing this test can say — it names no cause,
 *  and it is what a throw anywhere in window setup produced before the whenReady
 *  catch and the watchdog below existed. */
let smokeVerdictWritten = false;
/** How far the self-test got. A watchdog verdict that only says "no verdict" names
 *  no cause and sends whoever reads it back to bisecting by hand; this makes the
 *  hang point part of the report. */
let smokeStage = "init";
function smokeAt(stage) {
  smokeStage = stage;
}
function writeSmokeVerdict(verdict) {
  if (smokeVerdictWritten) return;
  smokeVerdictWritten = true;
  verdict = { ...verdict, stage: smokeStage };
  console.log((verdict.ok ? "SMOKE_RESULT " : "SMOKE_ERROR ") + JSON.stringify(verdict));
  if (SMOKE_OUT) {
    try {
      fs.writeFileSync(SMOKE_OUT, JSON.stringify(verdict));
    } catch {
      /* the caller's assertion on a missing file is the fallback */
    }
  }
  // app.exit, not app.quit: quit always exits 0, and it would also run the window's
  // confirm-before-closing handler. The file above is the real verdict either way —
  // this is belt and braces for a human running it.
  app.exit(verdict.ok ? 0 : 1);
}

/** Poll rather than sleep: the answer usually arrives in well under a second, and
 *  a fixed sleep is either slower than it needs to be or shorter than the slowest
 *  CI runner — the two ways a smoke test becomes flaky. */
async function pollUntilSettled(win, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = JSON.parse(await win.webContents.executeJavaScript(SMOKE_PROBE));
    if (smokeExpectationMet(last)) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function createWindow() {
  let loadError = null; // self-test only — see the SMOKE block at the end
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
      // The self-test's window is never shown (`show: !SMOKE`), and Chromium
      // throttles timers in hidden renderers — which would stretch the very 5s boot
      // timeout the offline test is measuring. Left on, this is the check that
      // passes on a fast afternoon runner and fails on a loaded one at 2am.
      ...(SMOKE ? { backgroundThrottling: false } : {}),
    },
  });

  // Self-test bookkeeping. Installed BEFORE the first load so nothing that happens
  // during boot — the very window the test is about — goes unobserved.
  const smokeAttemptedHosts = [];
  const smokeConsoleErrors = [];
  if (SMOKE) {
    smokeAt("window-created");
    // Session-level only here; the CDP half waits until a renderer exists (below).
    if (SMOKE_OFFLINE) blockNetworkRequestsForSmoke(win, smokeAttemptedHosts);
    win.webContents.on("console-message", (...args) => {
      // Electron moved this event's signature: it used to be
      // (event, level:number, message, line, sourceId) and is now (details) with
      // string levels. Read both rather than pin the test to an Electron version.
      const details = args[0] || {};
      const level = typeof args[1] === "undefined" ? details.level : args[1];
      const message = typeof args[2] === "undefined" ? details.message : args[2];
      const isError = level === "error" || level === 3;
      if (!isError || smokeConsoleErrors.length >= 20) return;
      smokeConsoleErrors.push(String(message).slice(0, 300));
    });
  }

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

  const load = () =>
    DEV_URL
      ? win.loadURL(DEV_URL + (SMOKE_HASH ? `#${SMOKE_HASH}` : ""))
      : win.loadFile(INDEX_HTML, SMOKE_HASH ? { hash: SMOKE_HASH } : undefined);

  // Renderer-loss recovery (crash reload and the renderer's own AppErrorBoundary
  // location.reload()) must come back on the page the show was actually running
  // on, not /dashboard. getURL() survives renderer death —
  // it's tracked by the webContents itself, not the dead document — so it still
  // has the last-committed hash (e.g. "#/events/<id>/run-order/live") to restore.
  // Falls back to a fresh load() when there's nothing usable (first load never
  // committed, or the URL somehow isn't our own app).
  const reloadToLastKnownUrl = () => {
    // The window can be gone by the time a crash handler runs (quit racing the
    // crash), and every call below throws synchronously on a destroyed window —
    // which in a main-process event handler means an uncaught exception, i.e.
    // taking the whole app down while recovering from a crash.
    if (win.isDestroyed()) return Promise.resolve();
    const current = win.webContents.getURL();
    if (current && current.startsWith(appUrl)) {
      // NOT loadURL(current): every route in this HashRouter SPA is "the same
      // URL, differing only by fragment" from Chromium's point of view, which it
      // classifies as a SAME-DOCUMENT navigation — no document actually reloads,
      // so a crashed renderer never comes back. reload() is unconditionally
      // cross-document and preserves the current hash on its own. It returns
      // void (not a Promise), so wrap it to keep callers' .catch() chains valid.
      win.webContents.reload();
      return Promise.resolve();
    }
    return load();
  };

  // The show power-save-blocker is started by the renderer (see set-show-running
  // above) and only ever stopped by an explicit renderer call or window-all-closed
  // — a React cleanup effect never runs when the document itself is torn down. Every
  // path that reloads/replaces the renderer document must release it here from the
  // main side, or display-sleep stays blocked for the rest of the app's life. The
  // freshly booted renderer re-asserts it on mount if the restored show is running.
  // isInPlace excludes normal in-app HashRouter navigation (no document reload).
  win.webContents.on("did-start-navigation", (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) stopShowPowerSaveBlocker();
  });

  // A dead renderer leaves a blank dark rectangle — no window navigate, no console,
  // and AppErrorBoundary (src/main.tsx) can't catch a process that no longer exists
  // to throw into it. The realistic vector here is OOM: Live Mode holds several
  // 27–88 MB WAV blobs plus their decoded audio all at once. Reload by default —
  // the SPA persists a running show's snapshot (see the beforeunload guard above)
  // and restores it, so a reload recovers the show instead of just the window.
  // "clean-exit"/"killed" are excluded: those are OUR OWN app.quit()/process kill,
  // not a crash, and reloading then would fight a deliberate shutdown.
  let recentReloads = [];
  const MAX_RELOADS_PER_WINDOW = 3;
  const RELOAD_WINDOW_MS = 60_000;
  win.webContents.on("render-process-gone", (_e, details) => {
    if (details.reason === "clean-exit" || details.reason === "killed") return;
    stopShowPowerSaveBlocker(); // the document that was holding it is gone either way
    const now = Date.now();
    recentReloads = recentReloads.filter((t) => now - t < RELOAD_WINDOW_MS);
    if (recentReloads.length >= MAX_RELOADS_PER_WINDOW) {
      // Reloading into whatever keeps killing the renderer would just loop forever
      // — stop and tell the operator instead of flashing the window indefinitely.
      dialog.showMessageBox(win, {
        type: "error",
        title: "CueIQ ค้างซ้ำ",
        message: `แอปพังซ้ำหลายครั้งติดกัน (${details.reason})`,
        detail: "ปิดโปรแกรมแล้วเปิดใหม่ด้วยตนเอง — ถ้าเปิด Quick Show ได้ ใช้คุมโชว์ต่อแบบไม่ต้องใช้เน็ต",
      });
      return;
    }
    recentReloads.push(now);
    console.log("RENDER_PROCESS_GONE " + details.reason + " — reloading");
    reloadToLastKnownUrl().catch((e) =>
      console.log("RENDER_PROCESS_GONE_RELOAD_FAIL " + String(e))
    );
  });

  // "Unresponsive" (renderer blocked on the main thread — e.g. decoding a big WAV)
  // is not dead yet, so this is informational only — no reload button. A parentless
  // dialog still gets Windows' focus (parentless only skips DISABLING the main
  // window — it doesn't stop the OS activating the new top-level window), so the
  // operator's own cue keys (e.g. → then Space, exactly what gets pressed mid-show)
  // land on whatever the dialog's default button is. A single dismiss button means
  // there's nothing destructive for a stray keystroke to trigger.
  //
  // ⚠️ Nothing here recovers a renderer that never comes back: Chromium only
  // EMITS "unresponsive", it does not kill the process, and render-process-gone
  // fires on a crash/OOM/kill — not on a wedged main thread. So the message says
  // what is actually true (restart it yourself, or run the show from Quick Show)
  // rather than promising a self-heal that will not arrive mid-show.
  let unresponsiveDialogOpen = false;
  win.webContents.on("unresponsive", () => {
    if (unresponsiveDialogOpen) return; // don't stack a prompt per hang tick
    unresponsiveDialogOpen = true;
    dialog
      .showMessageBox({
        type: "warning",
        buttons: ["รับทราบ"],
        defaultId: 0,
        cancelId: 0,
        title: "CueIQ ไม่ตอบสนอง",
        message: "แอปไม่ตอบสนองชั่วคราว",
        detail:
          "ถ้ากำลังโหลด/ประมวลผลไฟล์เสียงใหญ่ รอสักครู่มักกลับมาเอง — ถ้าค้างนานจริง ให้ปิดโปรแกรมแล้วเปิดใหม่ (โชว์ที่ค้างไว้จะกลับมาต่อ) หรือใช้ Quick Show คุมโชว์ต่อแบบไม่ต้องใช้เน็ต",
      })
      .then(() => {
        unresponsiveDialogOpen = false;
      })
      .catch((e) => {
        unresponsiveDialogOpen = false;
        console.log("UNRESPONSIVE_PROMPT_FAIL " + String(e));
      });
  });

  if (!SMOKE) {
    await load();
  } else {
    // Under the self-test a FAILED load is the headline result, not a crash: left
    // to reject, this function just stops and the hidden window sits there until
    // CI's timeout kills it three minutes later with nothing to say. Catch it, so
    // the verdict below reports "could not load" in seconds.
    try {
      smokeAt("loading");
      await load();
      smokeAt("loaded");
    } catch (e) {
      loadError = String(e);
    }
  }

  if (SMOKE) {
    // Headless self-test: confirm the renderer actually booted from disk. This is
    // the ONE check that runs the thing we ship — `vite build` proves the bundle
    // compiles, not that the packaged app opens. A file:// path that resolves in
    // dev and 404s once packaged, a preload that throws, a renderer that white-
    // screens: all of them build green and only show up when someone double-clicks
    // the installer. Which, until now, nobody did before publishing it.
    const context = {
      mode: SMOKE_SEED_FILE ? "seeded" : "cold",
      offline: SMOKE_OFFLINE,
      expect: SMOKE_EXPECT || "anything-rendered",
      // A stale win-unpacked next to a bumped package.json would otherwise pass for
      // the tag being released.
      appVersion: app.getVersion(),
      // Reported so a typo in the profile switch cannot silently share the real
      // %APPDATA%\CueIQ profile — which would make "cold boot" a claim about
      // whatever the last run left behind.
      userDataPath: app.getPath("userData"),
    };
    let verdict = { ok: false, ...context, error: loadError ?? "no result" };
    try {
      if (loadError) throw new Error(loadError);
      // Now that a renderer exists, flip navigator.onLine — BEFORE the reload
      // below, so the boot actually under test begins already offline.
      let onLineAfterCut = null;
      if (SMOKE_OFFLINE) {
        smokeAt("cdp-offline");
        await emulateOfflineViaCdp(win);
        onLineAfterCut = await win.webContents.executeJavaScript("navigator.onLine");
      }

      let planted = 0;
      if (SMOKE_SEED_FILE) {
        smokeAt("seeding");
        planted = await plantSmokeSeed(win);
        smokeAt("seeded");
      } else if (SMOKE_OFFLINE) {
        // No seed to plant, but the first load happened before the flag flipped, so
        // this boot has to be redone for the test to mean what it says.
        smokeAt("reloading-offline");
        await reloadAndWait(win, "into the offline boot");
      }
      // 25s: an offline boot spends its first seconds inside supabase-js's retrying
      // token refresh and then App.tsx's 5s BOOT_SESSION_TIMEOUT_MS before it can
      // reach the offline pass. Polling means the usual case still finishes in well
      // under a second — only a genuine failure waits out the deadline.
      smokeAt("polling");
      const probe = await pollUntilSettled(win, 25_000);
      smokeAt("polled");
      // Prove the cut rather than assume it. Without this the whole offline test
      // stays green the day one of the three mechanisms stops taking effect, and it
      // would be testing an ordinary online boot while claiming otherwise.
      smokeAt("net-probe");
      const netProbe = SMOKE_OFFLINE ? await proveTheNetworkIsCut(win) : null;
      smokeAt("verdict");
      const cutHeld = !netProbe || (netProbe.main === "rejected" && netProbe.renderer === "rejected");
      verdict = {
        ok: smokeExpectationMet(probe) && cutHeld,
        ...context,
        planted,
        ...probe,
        onLineAfterCut,
        netProbe,
        ...(cutHeld ? {} : { failReason: "the network cut did not hold" }),
        // Empty is the claim worth making on an offline boot: the app reached a
        // usable screen without asking the network for anything.
        attemptedHosts: smokeAttemptedHosts,
        consoleErrors: smokeConsoleErrors,
      };
    } catch (e) {
      verdict = {
        ok: false,
        ...context,
        error: String(e),
        attemptedHosts: smokeAttemptedHosts,
        consoleErrors: smokeConsoleErrors,
      };
    } finally {
      writeSmokeVerdict(verdict);
    }
  }
}

app.whenReady().then(() => {
  registerIpc();
  // Under the self-test, ANY throw during window setup used to end as silence: the
  // promise rejected, nothing was written, and CI reported "the packaged app never
  // reported — it crashed or hung on boot" for what was a one-line mistake in the
  // test scaffolding itself. Two backstops, both funnelling into writeSmokeVerdict:
  // catch the rejection, and time-box the whole run in case something never settles
  // rather than throwing (a debugger attach, a load that hangs).
  if (SMOKE) {
    const watchdog = setTimeout(() => {
      writeSmokeVerdict({ ok: false, failReason: "watchdog: no verdict within 90s" });
    }, 90_000);
    // Do not hold the process open on the watchdog alone.
    if (typeof watchdog.unref === "function") watchdog.unref();
  }
  // Deliberately NOT awaited: the update prompt is parentless, so it needs no
  // window — and awaiting the page load would let a failed load take both the
  // updater and the activate handler down with it.
  createWindow().catch((e) => {
    if (SMOKE) writeSmokeVerdict({ ok: false, failReason: "createWindow threw", error: String(e) });
    else console.log("CREATE_WINDOW_FAIL " + String(e));
  });
  initAutoUpdate();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopShowPowerSaveBlocker(); // no window left to run a show from
  if (process.platform !== "darwin") app.quit();
});
