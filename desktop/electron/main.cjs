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
// ⚠️ ALSO WHEN A STUB BACKEND IS IN PLAY, not only when the scenario is "offline".
// The two-device scenario runs ONLINE against the local stub, and the first version
// of it left real DNS alive: the renderer's realtime socket resolved the REAL
// Supabase host and connected to PRODUCTION with a fixture JWT (it was refused —
// "JwtSignatureError" — which is how it was noticed). A test must not be able to
// reach the live project at all, whatever else it gets wrong. Everything the app
// legitimately needs here is on 127.0.0.1, and those two EXCLUDEs keep it reachable.
if (
  process.env.CUEIQ_SMOKE === "1" &&
  (process.env.CUEIQ_SMOKE_OFFLINE === "1" || process.env.CUEIQ_SMOKE_BACKEND)
) {
  // EXCLUDE localhost for the handover scenario, whose FIRST phase is an ordinary
  // online boot against a stub Supabase on 127.0.0.1 — the whole point being that
  // the app fills its own caches before anything is cut. Chromium is documented to
  // short-circuit IP literals ahead of the resolver, which would make the exclusion
  // redundant; it is written out anyway, because "documented to" is the kind of
  // assumption that turns into a twenty-minute CI bisect when it stops holding, and
  // the clause costs nothing for the scenarios that do not use it. Every real
  // hostname still resolves to nothing, in the main process as well as the renderer.
  app.commandLine.appendSwitch(
    "host-resolver-rules",
    "MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost"
  );
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
//   CUEIQ_SMOKE_EXPECT     "signed-in" | "signed-out" | "quick-show" — what the boot
//                          must reach. Empty is a FAILURE, not a weaker question.
const SMOKE_SEED_FILE = process.env.CUEIQ_SMOKE_SEED_FILE || "";
// ⚠️ `SMOKE &&` is not belt-and-braces, it is the difference between a self-test flag
// and a production kill switch. SMOKE_OFFLINE gates assertNotOfflineSmoke() at the top
// of fetchAudioBytes/putAudioBytes — real paths on every launch — so derived from
// CUEIQ_SMOKE_OFFLINE alone, a stray variable left in the environment of the machine
// that runs the show means no audio plays at all, with a message about a smoke test.
// The host-resolver block at the top of this file already requires both; match it.
const SMOKE_OFFLINE = SMOKE && process.env.CUEIQ_SMOKE_OFFLINE === "1";
const SMOKE_EXPECT = process.env.CUEIQ_SMOKE_EXPECT || "";
// What the seeded cache should surface once it is read back. Kept as env rather
// than baked in here so main.cjs stays generic and the fixture owns its own values
// (desktop/scripts/make-smoke-seed.mjs exports both).
const SMOKE_EXPECT_TENANT = process.env.CUEIQ_SMOKE_EXPECT_TENANT || "";
const SMOKE_EXPECT_EVENTS = process.env.CUEIQ_SMOKE_EXPECT_EVENTS || "";
// Route to open on, without a hash (e.g. "/my-show"). The self-test has no input
// driver, so a scenario about a specific screen has to start there.
// `SMOKE &&` for the same reason as SMOKE_OFFLINE above, and it matters MORE here:
// this one is read by load(), which runs on every normal launch, so without the gate
// a stray CUEIQ_SMOKE_HASH in the show laptop's environment silently reroutes the
// app's boot route.
const SMOKE_HASH = (SMOKE && process.env.CUEIQ_SMOKE_HASH) || "";
// A URL that WOULD resolve if the network were up — see probeTheNetwork. The caller
// derives it from the same place the bundle gets its Supabase URL and there is no
// default here on purpose: a probe with nothing real to aim at is worse than no probe,
// because it answers "cut" forever. Empty ⇒ the cut is UNCALIBRATED and the run fails.
const SMOKE_PROBE_URL = process.env.CUEIQ_SMOKE_PROBE_URL || "";
// ── The handover scenario: online first, THEN the network cut ────────────────
// Everything above tests the app reading caches that the TEST wrote. That proves the
// offline read path and the boot gate, and run-smoke's header has always said so —
// but the other half of the founder's airplane test is the half nothing covered:
// does an ONLINE session write those caches correctly before the wifi dies?
//
// CUEIQ_SMOKE_BACKEND points at a local stub of the Supabase HTTP API
// (desktop/scripts/smoke-backend.mjs). The renderer cannot be told about it — the
// Supabase URL is substituted into the bundle at BUILD time by vite's `define`, so
// the string is baked into the artifact under test. Redirecting at the network layer
// is therefore not a shortcut, it is the only way to swap the backend while still
// launching the exact build that ships.
//
// `SMOKE &&` for the same reason as SMOKE_OFFLINE: without it a stray variable in the
// show laptop's environment would silently point the real app at a dead localhost.
const SMOKE_BACKEND = (SMOKE && process.env.CUEIQ_SMOKE_BACKEND) || "";
// The host whose traffic gets redirected. Derived by the caller from the same place
// the bundle got its URL, never guessed here.
const SMOKE_BACKEND_FOR = (SMOKE && process.env.CUEIQ_SMOKE_BACKEND_FOR) || "";
// Two phases in one launch: boot ONLINE against the stub, wait for the app to fill
// its own caches, then cut the network and cold-boot again on what it wrote.
const SMOKE_HANDOVER = SMOKE && process.env.CUEIQ_SMOKE_HANDOVER === "1";
// {"loginId":"…","password":"…"} — typed into the real login form, because the
// handover scenario is only worth having if NOTHING it later reads was planted by
// the test. Signing in is also the first half of the venue story the whole test is
// about: the operator logs in at the hotel and drives to the show.
const SMOKE_SIGN_IN = (SMOKE && process.env.CUEIQ_SMOKE_SIGN_IN) || "";
// ── The two-device scenario: two of these processes, one show ────────────────
// Everything above is about ONE device. The last item on this project's hand-run
// list that a machine can take over is the opposite: the PA running a show and a
// second device opening the same live page. Its arbitration is unit-tested
// (lib/live-arbitration.ts) and its wiring jsdom-tested, but until now nothing ran
// the two halves as two processes over a socket — and the worst bug this app has
// shipped lived exactly there (a phone that merely OPENED the page could win the
// tie against a PA that had reloaded mid-show, and stop the music).
//
// CUEIQ_SMOKE_REALTIME=1 serves the websocket from the same stub instead of
// cancelling it. Without this every channel stays down, which is right for the
// offline scenarios and useless for this one.
const SMOKE_REALTIME = SMOKE && process.env.CUEIQ_SMOKE_REALTIME === "1";
// "main" = press START SHOW and hold it; "peer" = open the same show and adopt it.
// The role decides what this process DOES, never what it is allowed to do: both
// launch the identical build with the identical account, which is the point —
// nothing about the arbitration may depend on the test knowing who should win.
const SMOKE_LIVE = (SMOKE && process.env.CUEIQ_SMOKE_LIVE) || "";
const SMOKE_LIVE_EVENT = (SMOKE && process.env.CUEIQ_SMOKE_LIVE_EVENT) || "";
// ── The audible scenario: does a real file actually make a real signal? ──────
// Everything else in this file asserts on state — a flag, a screen, an index. The
// one question พี่ has always had to answer with his own ears is whether sound
// comes OUT. A machine cannot listen to a room, but it can watch the audio graph
// inside the app: CUEIQ_SMOKE_AUDIO_FILE is a real WAV the runner generated, planted
// into the app's OWN audio cache (IndexedDB, lib/audio-store's schema) for the
// setlist row named by CUEIQ_SMOKE_LIVE_ITEM. The app then plays it through its own
// code, and the probe measures the waveform leaving the element.
const SMOKE_AUDIO_FILE = (SMOKE && process.env.CUEIQ_SMOKE_AUDIO_FILE) || "";
const SMOKE_LIVE_ITEM = (SMOKE && process.env.CUEIQ_SMOKE_LIVE_ITEM) || "";
// Time-box the whole self-test. The caller owns this number because it also owns the
// deadline it waits on, and the inner one must always fire first (run-smoke.mjs).
const SMOKE_WATCHDOG_MS = Number(process.env.CUEIQ_SMOKE_WATCHDOG_MS) || 90_000;
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

/** Make "no network" real.
 *
 *  Two layers on purpose. webRequest cancellation is the deterministic one — a
 *  cancelled request fails instantly, where emulated-offline can sit in Chromium's
 *  retry logic and turn a 20-second test into a 3-minute CI timeout.
 *  enableNetworkEmulation backs it up for anything that never reaches webRequest.
 *  The main process's own net.fetch is cut separately (assertNotOfflineSmoke).
 *
 *  This used to ALSO collect the hosts it cancelled, into an `attemptedHosts` field
 *  whose comment called an empty list "the claim worth making". Nothing ever asserted
 *  it, and it could not have: a healthy airplane boot cancels the Supabase host
 *  several times over (auth-js retries its token refresh), so the claim the comment
 *  made was one every green run contradicted. What actually distinguishes "booted
 *  offline" from "booted and hung on the network" is asserted elsewhere and for real —
 *  probeTheNetwork proves the cut, probe.onLine proves the app knew, and the console
 *  allowlist bounds what the cut is allowed to break. */
function blockNetworkRequestsForSmoke(win) {
  const ses = win.webContents.session;
  // ⚠️ NEVER "<all_urls>" or "*://*/*" here: the app's own document and bundle are
  // file:// URLs, and cancelling those blanks the window — a test that then reports
  // "rendered nothing" for a reason that has nothing to do with the app.
  ses.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (_details, callback) => callback({ cancel: true })
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
/** Point the app's Supabase traffic at the local stub, without touching the build.
 *
 *  Installed BEFORE the first load and left in place for the whole run: the offline
 *  phase cancels everything anyway (blockNetworkRequestsForSmoke registers its own
 *  handler, and the LAST onBeforeRequest listener registered wins in Electron), so
 *  this one does not need unwinding.
 *
 *  ⚠️ Redirect, do not proxy. A proxy would put this file in the business of
 *  understanding PostgREST; a redirect leaves the renderer making its own real
 *  requests, with its own real headers and its own real supabase-js, at a different
 *  host. The only thing the test changes is where the packets go. */
function serveSupabaseFromStub(win, host, backend) {
  const ses = win.webContents.session;
  const base = backend.replace(/\/+$/, "");

  // ⚠️ SERVE IT, DO NOT REDIRECT IT — and the reason is a spec rule, not a quirk.
  // The first cut used webRequest.onBeforeRequest with a redirectURL, and the stub
  // logged `200 POST /auth/v1/token` immediately followed by `401 GET /auth/v1/user`.
  // Sign-in worked (that call authenticates with a body and an apikey header) and the
  // very next call, which authenticates with a Bearer token and nothing else, arrived
  // naked: fetch strips Authorization, Cookie and Proxy-Authorization when a redirect
  // crosses origins, and https://<project>.supabase.co → http://127.0.0.1:<port>
  // crosses about as hard as it is possible to cross. Every read would have come back
  // 401, phase one would have cached nothing, and the scenario would have reported
  // "the app never wrote its caches" — true, and pointing at the wrong thing entirely.
  // Carrying the header across by hand does not work either: onBeforeRequest runs
  // BEFORE headers are computed, so the redirect happens before there is anything to
  // capture.
  //
  // Handling the scheme instead keeps the renderer's request exactly as it was — same
  // URL, same headers, same origin — and forwards it from the main process, where no
  // browser rule applies. It also means the response comes back as if it came from
  // Supabase, so the app's CORS story is unchanged too.
  ses.protocol.handle("https", async (request) => {
    const url = new URL(request.url);
    if (url.host !== host) {
      // Everything else is dead by design (host-resolver-rules), and answering
      // rather than hanging keeps a stray request from eating the scenario's clock.
      return new Response("smoke: only the Supabase host is served", { status: 502 });
    }
    try {
      return await net.fetch(new Request(base + url.pathname + url.search, request), {
        bypassCustomProtocolHandlers: true,
      });
    } catch (e) {
      return new Response(`smoke stub unreachable: ${String(e)}`, { status: 502 });
    }
  });

  // The realtime socket is NOT served by the code above: protocol.handle does not
  // cover wss, and a webRequest redirect does not work on a websocket handshake
  // either (measured — the app connected to the REAL Supabase regardless, which is
  // also why real DNS is now dead for any scenario with a stub). The socket is
  // pointed at the stub in the renderer instead, by patchWebSocketHostViaCdp.
  //
  // Here, the default: CANCEL. That is the honest simulation of "the socket never
  // came up", which is what a venue gets and what every scenario but one is about;
  // serving it there would quietly test a friendlier world. SMOKE_REALTIME leaves
  // the socket alone so the patched constructor can reach 127.0.0.1.
  if (!SMOKE_REALTIME) {
    ses.webRequest.onBeforeRequest({ urls: ["wss://*/*", "ws://*/*"] }, (_d, callback) =>
      callback({ cancel: true })
    );
  }
}

/**
 * Point the renderer's WebSocket at the stub, from inside the renderer.
 *
 * ⚠️ THE THREE THINGS THAT DO NOT WORK, so nobody spends the afternoon again:
 *   • `protocol.handle("wss")` — protocol handlers do not cover websockets.
 *   • `webRequest.onBeforeRequest` with a redirectURL — a websocket handshake is
 *     not redirected by it. The first cut of the two-device scenario did this and
 *     the app connected to PRODUCTION realtime with a fixture JWT; the only reason
 *     it was noticed is that the real server refused the signature out loud.
 *   • Changing the URL in the build — the Supabase URL is baked in by vite's
 *     `define`, and the whole point is to launch the artifact that ships.
 *
 * So patch the constructor, the same way navigator.onLine is patched for the
 * airplane test, and for the same reason: it changes WHERE the bytes go and
 * nothing else. Same client, same protocol, same messages — realtime-js does not
 * know it happened. Page.addScriptToEvaluateOnNewDocument runs before any script
 * in the document, so the app's very first channel is already pointed here.
 */
async function patchWebSocketHostViaCdp(win, host, httpBase) {
  const wsBase = httpBase.replace(/\/+$/, "").replace(/^http/, "ws");
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach("1.3");
  await dbg.sendCommand("Page.enable");
  await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const Native = window.WebSocket;
      const rewrite = (url) => {
        try {
          const u = new URL(String(url));
          if (u.host !== ${JSON.stringify(host)}) return url;
          return ${JSON.stringify(wsBase)} + u.pathname + u.search;
        } catch { return url; }
      };
      // A subclass, not a wrapper function: realtime-js reads WebSocket.OPEN and
      // friends off the constructor, and those ride the prototype chain here.
      class SmokeWebSocket extends Native {
        constructor(url, protocols) { super(rewrite(url), protocols); }
      }
      window.WebSocket = SmokeWebSocket;
    })();`,
  });
}

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
 *  ⚠️ THE URL IS THE WHOLE PROBE, and the first cut of this got it exactly backwards.
 *  It aimed at `process.env.NEXT_PUBLIC_SUPABASE_URL || "https://example.invalid"`,
 *  and neither workflow sets that variable — so it aimed at `.invalid`, an RFC 2606
 *  reserved TLD that is GUARANTEED never to resolve. Both probes therefore answered
 *  "rejected" with the network fully up. Measured, not reasoned: I ran the airplane
 *  scenario with all three cut layers disabled and real internet, and netProbe still
 *  came back {main: "rejected", renderer: "rejected"}. `cutHeld` was a check that
 *  could never fail — this round's stated defect class, sitting inside the very
 *  function whose docstring promises the opposite. The caller now supplies a host
 *  that really is reachable, and an absent one is a FAILURE, not a default.
 *
 *  net.fetch DIRECTLY, not through fetchAudioBytes: that path would be refused by
 *  assertR2Url's host pin and would therefore "reject" just as convincingly with the
 *  network fully up.
 *
 *  `expect` is "rejected" for an offline scenario and "resolved" for an online one.
 *  Only the resolve direction retries: a cut leaks instantly and deterministically,
 *  whereas one dropped packet on a runner should not turn a calibration into a red
 *  build. Every attempt is time-boxed, because a probe that hangs hands the run to
 *  the watchdog with nothing to say. */
async function probeTheNetwork(win, expect) {
  const url = SMOKE_PROBE_URL.replace(/\/+$/, "") + "/auth/v1/health";
  const attempts = expect === "resolved" ? 3 : 1;
  const probe = async (run) => {
    for (let i = 0; i < attempts; i++) {
      try {
        await run();
        return "resolved";
      } catch {
        if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return "rejected";
  };
  return {
    main: await probe(() =>
      net.fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) })
    ),
    renderer: await probe(() =>
      win.webContents.executeJavaScript(
        // `.then(() => true)` matters: executeJavaScript resolves with the script's
        // value, and a Response is not structured-cloneable. Handing it back raw makes
        // the answer depend on how Electron serialises an object it cannot clone —
        // and if that ever throws, a perfectly reachable host reads as "rejected",
        // which would fail the control calibration for no reason at 2am. Return a
        // boolean and the only thing that can reject is the fetch itself.
        `fetch(${JSON.stringify(url)}, { cache: "no-store", signal: AbortSignal.timeout(10000) }).then(() => true)`
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
  // Returns nothing on purpose. It used to hand back the number of keys it wrote, and
  // that number rode the verdict as `planted` with nobody asserting it — it could only
  // ever have equalled the key count of the file this same function just read, so an
  // assertion on it would have compared a number with itself. What a seed that failed
  // to arrive really looks like is a signed-OUT app, and run-smoke.mjs's control ⇄
  // airplane cross-check is what catches that. A throw in here (quota, a hostile key)
  // still rejects and lands in the verdict as `error`.
  await win.webContents.executeJavaScript(
    `(() => { const e = JSON.parse(${payload});
      for (const k of Object.keys(e)) window.localStorage.setItem(k, e[k]); })()`
  );
  await reloadAndWait(win, "after seeding");
}

// ─── the two-device driver (CUEIQ_SMOKE_LIVE only) ───────────────────────────

/** Read/set a rendezvous flag on the stub.
 *
 *  Why a flag and not a sleep: the PA must write its verdict AFTER the second
 *  device has joined, and the second device must join AFTER the show is running.
 *  A sleep long enough to be safe on a cold CI runner is long enough to make the
 *  scenario slow, and any sleep at all is a scenario that goes red at 2am for
 *  reasons no log explains. The stub is the one thing all three processes (both
 *  apps and the runner) can already reach. */
async function smokeMark(name, { set = false } = {}) {
  if (!SMOKE_BACKEND) throw new Error("smokeMark needs CUEIQ_SMOKE_BACKEND");
  const res = await net.fetch(`${SMOKE_BACKEND.replace(/\/+$/, "")}/smoke/mark/${name}`, {
    method: set ? "POST" : "GET",
  });
  const body = await res.json();
  return body.set === true;
}

/** Poll a rendezvous flag until it is set, or fail NAMING the flag — a bare
 *  timeout here would read as "the app hung" for a runner that simply never got
 *  far enough to raise it. */
async function waitForMark(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await smokeMark(name)) return;
    if (Date.now() >= deadline) {
      throw new Error(`the rendezvous mark "${name}" was never set within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Keep a register of every audio element the app constructs.
 *
 * ⚠️ THE ELEMENTS ARE NOT IN THE DOCUMENT. live-mode.tsx builds its two players
 * with `new Audio()` and never appends them, so `document.querySelectorAll("audio")`
 * finds nothing and the first cut of the audible scenario reported "no audio element
 * on the page" while the app was playing perfectly. Nothing about that is a bug —
 * a detached element is the right way to own a playhead — but it means the probe
 * has to be told where to look.
 *
 * A wrapper function, not `class extends Audio`: Audio is a legacy factory
 * constructor and subclassing it is a good way to meet "Illegal constructor". A
 * plain function that news the original and returns it is exactly equivalent from
 * the caller's side, because a constructor returning an object yields that object.
 */
async function registerAudioElementsViaCdp(win) {
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach("1.3");
  await dbg.sendCommand("Page.enable");
  await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const Native = window.Audio;
      window.__cueiqSmokeAudio = [];
      const Patched = function (...args) {
        const el = new Native(...args);
        window.__cueiqSmokeAudio.push(el);
        return el;
      };
      Patched.prototype = Native.prototype;
      window.Audio = Patched;
    })();`,
  });
}

/** Plant a real audio file in the app's OWN cache, under the app's own schema.
 *
 *  lib/audio-store.ts: database "cueiq-audio", store "files", key
 *  `<eventId>::<itemId>`, value `{ blob, name, path }`. Written from outside rather
 *  than through the app's uploader because the uploader would need R2 — and the
 *  point here is the PLAYBACK path, not the download path (which the readiness
 *  gate and the offline scenarios already cover).
 *
 *  ⚠️ A plain Blob, never a File. live-mode.tsx treats a File-valued record as a
 *  dangling reference to a path on disk (that is what a picked file is in Chromium)
 *  and deliberately re-pulls real bytes over it, so a File here would be discarded
 *  by design and the show would play silence.
 *
 *  ⚠️ And it must run BEFORE Live Mode mounts: the restore is a mount effect.
 */
async function seedAudioForSmoke(win, eventId, itemId) {
  const wav = fs.readFileSync(SMOKE_AUDIO_FILE).toString("base64");
  const outcome = await win.webContents.executeJavaScript(`(() => new Promise((resolve) => {
    try {
      const bin = atob(${JSON.stringify(wav)});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "audio/wav" });
      const req = indexedDB.open("cueiq-audio", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
      };
      req.onerror = () => resolve("open failed: " + String(req.error));
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("files", "readwrite");
        tx.objectStore("files").put(
          { blob, name: "smoke-tone.wav", path: ${JSON.stringify(`smoke/${itemId}.wav`)} },
          ${JSON.stringify(`${eventId}::${itemId}`)}
        );
        tx.oncomplete = () => { db.close(); resolve("seeded " + blob.size + " bytes"); };
        tx.onerror = () => { db.close(); resolve("write failed: " + String(tx.error)); };
      };
    } catch (e) { resolve("threw: " + String(e)); }
  }))()`);
  if (!String(outcome).startsWith("seeded")) {
    throw new Error(`could not plant the audio file: ${outcome}`);
  }
  return outcome;
}

/** Listen to what the app is actually playing.
 *
 *  Three independent readings, because each one alone has a way of being satisfied
 *  by silence:
 *   • the element is playing and its playhead ADVANCED — a paused element reports a
 *     stable currentTime, and an element that failed to decode never advances;
 *   • it is not muted and its volume is not zero — Live Mode mutes viewers on
 *     purpose, and "playing" says nothing about whether anyone would hear it;
 *   • THE WAVEFORM. An AnalyserNode on the element's own output, sampled for about
 *     a second, and the peak RMS of what came through. This is the only reading
 *     that distinguishes "a file is playing" from "a signal exists": a silent WAV,
 *     a decode that yielded zeros, or a gain node left at zero all advance the
 *     playhead perfectly well.
 *
 *  ⚠️ What it CANNOT say: whether a speaker is connected, powered and unmuted. The
 *  graph is measured inside Chromium, before the operating system's mixer. This
 *  replaces "did the app try to play" with "the app produced a real signal" — it
 *  does not replace a person in the room.
 *
 *  ⚠️ createMediaElementSource REROUTES the element into the graph, so the analyser
 *  is connected straight on to ctx.destination. Without that the measurement itself
 *  would silence the app.
 */
async function measureTheSound(win) {
  return JSON.parse(
    await win.webContents.executeJavaScript(`(async () => {
      // The register first (live-mode.tsx's players are detached — see
      // registerAudioElementsViaCdp), the document second so this keeps working if
      // an element ever is appended.
      const els = Array.from(window.__cueiqSmokeAudio || []).concat(
        Array.from(document.querySelectorAll("audio"))
      );
      const el = els.find((a) => !a.paused && a.currentSrc) || els.find((a) => a.currentSrc) || els[0];
      if (!el) {
        return JSON.stringify({
          error: "no audio element exists at all (registered: " + (window.__cueiqSmokeAudio || []).length + ")",
        });
      }
      const before = el.currentTime;
      let rms = 0;
      let ctxState = "none";
      try {
        const ctx = new AudioContext();
        const source = ctx.createMediaElementSource(el);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        analyser.connect(ctx.destination);
        if (ctx.state === "suspended") await ctx.resume();
        ctxState = ctx.state;
        const buf = new Float32Array(analyser.fftSize);
        const until = Date.now() + 1200;
        while (Date.now() < until) {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          rms = Math.max(rms, Math.sqrt(sum / buf.length));
          await new Promise((r) => setTimeout(r, 40));
        }
      } catch (e) {
        return JSON.stringify({ error: "analyser: " + String(e), advanced: el.currentTime - before });
      }
      return JSON.stringify({
        playing: !el.paused,
        muted: el.muted,
        volume: el.volume,
        readyState: el.readyState,
        duration: Number.isFinite(el.duration) ? Number(el.duration.toFixed(2)) : null,
        advanced: Number((el.currentTime - before).toFixed(3)),
        rms: Number(rms.toFixed(5)),
        ctxState,
        src: (el.currentSrc || "").slice(0, 12),
      });
    })()`)
  );
}

/** What Live Mode says this device currently is — read off the attributes
 *  components/event/live-mode.tsx puts on its root. `null` until the page mounts.
 *  Structural, never textual: every label on that screen is Thai, and a wording
 *  change must not be able to break a cross-process assertion. */
const SMOKE_LIVE_STATE = `(() => {
  const el = document.querySelector('[data-cueiq-live]');
  if (!el) return null;
  return {
    controller: el.getAttribute('data-cueiq-live-controller') === '1',
    begun: el.getAttribute('data-cueiq-live-begun') === '1',
    index: Number(el.getAttribute('data-cueiq-live-index')),
    sound: el.getAttribute('data-cueiq-live-sound') === '1',
    sync: el.getAttribute('data-cueiq-live-sync'),
    settled: el.getAttribute('data-cueiq-live-settled') === '1',
    // Who this device IS, as the app itself knows it (lib/device-id.ts). The
    // two-device runner compares it against the device_id on the surviving
    // show_authority row — which is how "one device holds the show" becomes an
    // assertion about WHICH one, rather than a row count that a wrong winner
    // would satisfy just as well.
    deviceId: localStorage.getItem('cueiq:deviceId'),
  };
})()`;
const SMOKE_LIVE_PROBE = `JSON.stringify(${SMOKE_LIVE_STATE})`;

/** Poll Live Mode's own attributes until `done` accepts them. Reports the LAST
 *  reading on failure: "it never started" and "it started and then stepped down"
 *  are different bugs that look identical from a timeout. */
async function pollLive(win, what, done, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = JSON.parse(await win.webContents.executeJavaScript(SMOKE_LIVE_PROBE));
    if (last && done(last)) return last;
    if (Date.now() >= deadline) {
      // The page probe as well as the live state: "Live Mode never mounted" and
      // "Live Mode mounted and never settled" are different failures, and the first
      // one is usually not about Live Mode at all — it is a route that bounced, a
      // bundle that did not load, or a session that was not there yet. Without the
      // screen and the hash, every one of those reads the same.
      const page = await win.webContents.executeJavaScript(SMOKE_PROBE);
      throw new Error(`${what} — live=${JSON.stringify(last)} page=${page}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Drive this process's half of the two-device scenario.
 *
 * ROLE "main" — the PA. Opens the show, presses START SHOW, and then HOLDS while
 * the runner starts the second device. What it asserts is not that it started —
 * that is the easy half — but that it is still the controller, still begun, still
 * on the same item and still the one making sound AFTER a second device joined.
 *
 * ROLE "peer" — the phone that opens the same page mid-show. It presses nothing.
 * It must adopt the running show as a VIEWER: not controller, not sounding, and
 * showing the PA's item rather than item 0. Every one of those was a real bug.
 *
 * Returns what rides the verdict; throws with a sentence, never a bare timeout.
 */
async function driveLiveScenario(win) {
  if (!SMOKE_LIVE_EVENT) throw new Error("CUEIQ_SMOKE_LIVE needs CUEIQ_SMOKE_LIVE_EVENT");
  // ⚠️ WAIT FOR THE SHELL FIRST. signInThroughTheForm returns as soon as the form
  // is submitted, and the app is still on the login screen for a moment after that
  // — navigating there sets a hash the auth-gate immediately replaces with #/login,
  // and the symptom is "Live Mode never mounted", which points at the wrong file.
  smokeAt(`live:${SMOKE_LIVE}:waiting-for-shell`);
  {
    const deadline = Date.now() + 40_000;
    for (;;) {
      const page = JSON.parse(await win.webContents.executeJavaScript(SMOKE_PROBE));
      if (page.screen === "shell" && !page.loginVisible) break;
      if (Date.now() >= deadline) {
        throw new Error(`never reached the signed-in shell: ${JSON.stringify(page)}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  // In-page navigation, because the app is a HashRouter behind file:// — a
  // loadURL would restart the whole renderer and throw away the session.
  smokeAt(`live:${SMOKE_LIVE}:opening`);
  await win.webContents.executeJavaScript(
    `location.hash = ${JSON.stringify(`#/events/${SMOKE_LIVE_EVENT}/live`)}`
  );
  // The bundle has to load and the channel has to settle before START is even
  // enabled (live-mode.tsx disables it on !syncSettled, precisely so a device
  // cannot start a show that is already running elsewhere).
  const mounted = await pollLive(win, "Live Mode never mounted", (l) => l.settled, 40_000);

  if (SMOKE_LIVE === "audible") {
    // One device, no peer, and the only question is whether sound comes out.
    // The seeding happened before this function opened the live page (see the
    // caller) because the restore is a mount effect.
    smokeAt("live:audible:starting");
    // ⚠️ userGesture: true. Chromium's autoplay policy blocks audible playback
    // until the page has been activated by a user, and a scripted `.click()` is
    // NOT activation — without this flag the show starts, the playhead sits at
    // zero, and the failure reads as "no audio" for a reason that has nothing to
    // do with the app. This is the same permission a real press carries.
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('[data-testid=start-show]');
        if (!b) return 'no start button';
        if (b.disabled) return 'start button disabled';
        b.click(); return 'clicked'; })()`,
      true
    );
    if (clicked !== "clicked") throw new Error(`could not start the show: ${clicked}`);
    const started = await pollLive(
      win,
      "the show never started here",
      (l) => l.begun && l.controller,
      20_000
    );
    // Give the element time to reach the file and get going before listening —
    // and poll for it rather than sleeping, so a fast machine is not punished and
    // a slow one is not failed.
    smokeAt("live:audible:listening");
    const deadline = Date.now() + 15_000;
    let heard = null;
    for (;;) {
      heard = await measureTheSound(win);
      if (heard.playing && heard.advanced > 0) break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return { role: "audible", after: started, audio: heard, mountedSync: mounted.sync };
  }

  if (SMOKE_LIVE === "main" || SMOKE_LIVE === "main-yield") {
    smokeAt(`live:${SMOKE_LIVE}:starting`);
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('[data-testid=start-show]');
        if (!b) return 'no start button';
        if (b.disabled) return 'start button disabled';
        b.click(); return 'clicked'; })()`
    );
    if (clicked !== "clicked") throw new Error(`could not start the show: ${clicked}`);
    await pollLive(win, "the show never started here", (l) => l.begun && l.controller, 20_000);
    // ⚠️ ADVANCE THE SHOW BEFORE THE PEER EXISTS, and this is not decoration.
    // "Both screens agree on the item" is a check that cannot fail while both sit
    // at item 0 — which is exactly where a joiner that RESET the show would also
    // be. Moving the PA to item 2 is what turns that assertion into the fingerprint
    // of the bug it is looking for.
    smokeAt("live:main:advancing");
    for (let i = 0; i < 2; i++) {
      const advanced = await win.webContents.executeJavaScript(
        `(() => { const b = document.querySelector('[data-testid=next]');
          if (!b) return 'no next button'; if (b.disabled) return 'next disabled';
          b.click(); return 'clicked'; })()`
      );
      if (advanced !== "clicked") throw new Error(`could not advance the show: ${advanced}`);
    }
    const started = await pollLive(
      win,
      "the show never reached item 2",
      (l) => l.begun && l.controller && l.index === 2,
      20_000
    );
    // Tell the runner it may launch the second device — and only then.
    await smokeMark("main-started", { set: true });
    smokeAt(`live:${SMOKE_LIVE}:holding`);
    // Two ways to be released, one per scenario. "peer-settled" is set by the
    // RUNNER once the joining device has written its verdict (the show stays
    // here); "peer-took-control" is set by the PEER ITSELF the moment it takes the
    // show (the handoff scenario). Waiting on the wrong one would hold this device
    // until its watchdog and report a hang for a scenario that worked.
    await waitForMark(SMOKE_LIVE === "main-yield" ? "peer-took-control" : "peer-settled", 90_000);
    smokeAt(`live:${SMOKE_LIVE}:rechecking`);
    // ⚠️ Read the live state AGAIN rather than trusting `started`. The whole
    // scenario is about what a second device DID to this one, and a reading taken
    // before it joined cannot say.
    const after = JSON.parse(await win.webContents.executeJavaScript(SMOKE_LIVE_PROBE));
    return { role: SMOKE_LIVE, atStart: started, after, mountedSync: mounted.sync };
  }

  if (SMOKE_LIVE === "peer" || SMOKE_LIVE === "peer-take") {
    smokeAt(`live:${SMOKE_LIVE}:adopting`);
    // No press of anything. Adoption arrives over the socket: the PA answers this
    // device's sync-request with its state, and live-mode.tsx's "adoptingRunningShow"
    // branch is what must demote this page to a viewer.
    // `begun` AND the PA's item: a device that adopted the show but sat at item 0
    // has not adopted it, it has replaced it — and that difference is invisible
    // while the show has never advanced, which is why the PA moves first.
    const adopted = await pollLive(
      win,
      "this device never adopted the running show",
      (l) => l.begun && l.index > 0,
      45_000
    );
    await smokeMark("peer-joined", { set: true });
    if (SMOKE_LIVE === "peer") return { role: "peer", after: adopted, mountedSync: mounted.sync };

    // ── THE HANDOFF, which is the operator's real move ────────────────────────
    // "เครื่องเสียงคุมคนเดียว" is enforced in the UI, not merely in the arbitration:
    // the ขอควบคุม button DOES NOT EXIST on a muted viewer (live-mode.tsx renders
    // it only when soundOutput is on), because control and audio must travel
    // together. So this device has to do what a person does — turn its own output
    // on first, and only then ask for the show.
    smokeAt("live:peer-take:turning-sound-on");
    const soundOn = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('[data-testid=sound-output-toggle]');
        if (!b) return 'no sound toggle'; b.click(); return 'clicked'; })()`
    );
    if (soundOn !== "clicked") throw new Error(`could not turn the sound on: ${soundOn}`);
    await pollLive(win, "this device never took its sound output", (l) => l.sound, 10_000);

    smokeAt("live:peer-take:asking-for-control");
    const asked = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('[data-testid=request-control]');
        if (!b) return 'no request-control button — is this device still muted?';
        b.click(); return 'clicked'; })()`
    );
    if (asked !== "clicked") throw new Error(`could not ask for control: ${asked}`);
    const took = await pollLive(
      win,
      "this device asked for control and never got it",
      (l) => l.controller && l.sound && l.begun,
      20_000
    );
    // Release the old controller: it re-reads its own state and reports what the
    // handoff did to it. Set by THIS device rather than by the runner, because
    // only this device knows the moment control actually moved.
    await smokeMark("peer-took-control", { set: true });
    return { role: "peer-take", adopted, after: took, mountedSync: mounted.sync };
  }

  throw new Error(
    `CUEIQ_SMOKE_LIVE must be main / main-yield / peer / peer-take / audible, got "${SMOKE_LIVE}"`
  );
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
  live: ${SMOKE_LIVE_STATE},
})`;

/** Console errors an OFFLINE boot is allowed to produce. Anything else fails the run.
 *
 *  The alternative was to keep collecting them and assert nothing, which is the same
 *  as not collecting them: a React render error, a module that throws on eval, a
 *  failed IndexedDB open — none of those necessarily change `screen`, so all of them
 *  could ride a green airplane verdict. Each pattern below is here because a cut
 *  network CAUSES it, and for no other reason:
 *   • "Failed to fetch" — supabase-js's own fetch rejecting. Measured: this is the
 *     ONLY error a healthy airplane boot emits, five of them, from auth-js's retrying
 *     token refresh. Same five on a repeat run, and ZERO in the two online scenarios.
 *   • "net::ERR_" — Chromium's network stack logging the same cut from the other
 *     side: ERR_BLOCKED_BY_CLIENT (the webRequest layer), ERR_NAME_NOT_RESOLVED
 *     (host-resolver-rules), ERR_INTERNET_DISCONNECTED (the session emulation).
 *   • "Failed to load resource" — Chromium's wording when a SUBRESOURCE rather than
 *     a fetch() is the thing the cut stopped.
 *  ONLINE scenarios allow none of these: with the network up, "Failed to fetch" is a
 *  real defect and must not inherit the offline run's excuse. */
const SMOKE_ALLOWED_CONSOLE_ERRORS = [/Failed to fetch/i, /net::ERR_/, /Failed to load resource/i];

/** Did this boot land where it was told to? Every recognised value below names a
 *  screen the app has ARRIVED at rather than one it is passing through, which is why
 *  pollUntilSettled can poll on this predicate alone: "boot" and the loading half of
 *  "shell-fallback" satisfy none of them, so a spinner can never be sampled as an
 *  answer. (There used to be a TERMINAL_SCREENS list here saying the same thing, with
 *  a paragraph of documentation and not one reference — deleted. The guard that made
 *  it moot is the one at the top of the SMOKE block: an EMPTY expectation now fails
 *  the run outright, so "poll until anything renders" is not a state this can be in.) */
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
  // ── the two-device pair ──────────────────────────────────────────────────
  // Both halves demand `begun`, which is what makes them a PAIR rather than two
  // unrelated checks: the phone can only be a viewer OF something, and a PA that
  // stopped being begun has lost the show whatever else it still claims.
  if (SMOKE_EXPECT === "live-controller") {
    return !!p.live && p.live.begun && p.live.controller;
  }
  if (SMOKE_EXPECT === "live-viewer") {
    // NOT controller and NOT sounding: "เครื่องเสียงคุมคนเดียว" is a rule about the
    // room, not about the screen, and a second device that quietly kept its own
    // output on is two sound hosts on one stage.
    return !!p.live && p.live.begun && !p.live.controller && !p.live.sound;
  }
  // A value nobody here understands is NEVER met — and neither is an absent one,
  // which is why there is no `return true` under this line any more. Falling through
  // to `true` meant a typo in a scenario's env ("signedin") silently demoted that
  // scenario to the old, weakest question — did anything render — and passed.
  // run-smoke.mjs also asserts the verdict's echoed `expect` against what it asked
  // for, so the same mistake is caught from both ends.
  return false;
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
      // Write-then-RENAME, not writeFileSync onto the final path. The caller polls
      // fs.existsSync() every 500ms and parses the moment the file appears, and
      // writeFileSync creates the file BEFORE it has any bytes in it — so a poll that
      // lands inside that window reads "" and reports `unreadable verdict: SyntaxError`
      // for a run that actually succeeded. rename() on the same directory is atomic on
      // both NTFS and POSIX: the caller sees no file, then the whole file.
      const tmp = SMOKE_OUT + ".partial";
      fs.writeFileSync(tmp, JSON.stringify(verdict));
      fs.renameSync(tmp, SMOKE_OUT);
    } catch {
      /* the caller's assertion on a missing file is the fallback */
    }
  }
  // app.exit, not app.quit: quit always exits 0, and it would also run the window's
  // confirm-before-closing handler. The file above is the real verdict either way —
  // this is belt and braces for a human running it.
  app.exit(verdict.ok ? 0 : 1);
}

/** Which cache entries the APP ITSELF has written, straight out of localStorage.
 *
 *  This is the whole point of the handover scenario. Every other assertion in this
 *  file is about what the app READS; this one is about what it WROTE, and it is
 *  deliberately a list of keys rather than a boolean so a verdict can show that the
 *  workspace landed and the events list did not (the events cache key is derived
 *  from the account's viewable groups, which is exactly the kind of thing that goes
 *  quietly wrong). */
const SMOKE_CACHE_KEYS = `JSON.stringify(
  Object.keys(localStorage).filter((k) => k.indexOf('cueiq:cache:') === 0).sort()
)`;

/** Type credentials into the REAL login form and submit it.
 *
 *  ⚠️ The native value setter, not `el.value = …`. React tracks the last value it
 *  wrote on the DOM node; assigning `.value` directly updates the input on screen
 *  but leaves that tracker in step, so React's onChange never fires and the
 *  component's state stays empty — the form then submits two blank fields and the
 *  test reports "sign-in failed" for a reason that has nothing to do with the app.
 *  Going through the prototype setter is what makes the tracker notice. */
async function signInThroughTheForm(win, loginId, password) {
  // Wait for the form. The app does not open ON the login screen — App.tsx resolves
  // the session first and shows its boot card while it does — so typing immediately
  // finds no field and reports a sign-in failure for a page that had simply not
  // rendered yet.
  const deadline = Date.now() + 20_000;
  for (;;) {
    const ready = await win.webContents.executeJavaScript(
      `!!document.getElementById("loginId") && !!document.getElementById("password")`
    );
    if (ready) break;
    if (Date.now() >= deadline) {
      const screen = await win.webContents.executeJavaScript(
        `document.querySelector('[data-cueiq-screen]')?.getAttribute('data-cueiq-screen') || "none"`
      );
      throw new Error(`the login form never appeared (screen was "${screen}")`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const script = `(() => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const type = (id, value) => {
      const el = document.getElementById(id);
      if (!el) return false;
      set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };
    if (!type("loginId", ${JSON.stringify(loginId)})) return "no loginId field";
    if (!type("password", ${JSON.stringify(password)})) return "no password field";
    const form = document.querySelector("form");
    if (!form) return "no form";
    form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return "submitted";
  })()`;
  const outcome = await win.webContents.executeJavaScript(script);
  if (outcome !== "submitted") throw new Error(`could not drive the login form: ${outcome}`);
}

/** Phase 1 of the handover: wait until the ONLINE app has filled its own caches.
 *
 *  Waiting on the SCREEN would not do — the shell renders from an empty workspace
 *  just as happily — so this waits on the artefact the offline phase is about to
 *  depend on, and returns whatever it last saw so a failure can say which key was
 *  missing rather than "it did not work". */
async function pollUntilCachesWritten(win, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let keys = [];
  for (;;) {
    keys = JSON.parse(await win.webContents.executeJavaScript(SMOKE_CACHE_KEYS));
    const hasWorkspace = keys.includes("cueiq:cache:workspace");
    const hasEvents = keys.some((k) => k.startsWith("cueiq:cache:events:"));
    if (hasWorkspace && hasEvents) return { ok: true, keys };
    if (Date.now() >= deadline) return { ok: false, keys };
    await new Promise((r) => setTimeout(r, 250));
  }
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
  const smokeConsoleErrors = [];
  // Kept SEPARATE from the diagnostic list above, and separately capped, because this
  // one is fatal: sharing a cap would let twenty allowlisted "Failed to fetch" lines
  // hide the one error that matters behind them.
  const smokeUnexpectedConsoleErrors = [];
  if (SMOKE) {
    smokeAt("window-created");
    // The stub has to be reachable BEFORE the first load, because phase 1 of the
    // handover is an ordinary online boot that happens to answer to localhost.
    // (host-resolver-rules from the top of this file kills every real hostname and
    // leaves the stub alone: Chromium's resolver never touches an IP literal.)
    if (SMOKE_BACKEND && SMOKE_BACKEND_FOR) {
      serveSupabaseFromStub(win, SMOKE_BACKEND_FOR, SMOKE_BACKEND);
    }
    // Session-level only here; the CDP half waits until a renderer exists (below).
    // DEFERRED for the handover: cancelling everything now would take the stub with
    // it, and phase 1 is supposed to be online.
    if (SMOKE_OFFLINE && !SMOKE_HANDOVER) blockNetworkRequestsForSmoke(win);
    win.webContents.on("console-message", (...args) => {
      // Electron moved this event's signature: it used to be
      // (event, level:number, message, line, sourceId) and is now (details) with
      // string levels. Electron 42 — verified against node_modules/electron/
      // electron.d.ts and by running it — emits BOTH: args[0] is the details object
      // with level: 'info'|'warning'|'error'|'debug', and args[1..4] are the
      // deprecated positional (level: number 0..3, message, line, sourceId).
      // So test BOTH SOURCES rather than picking one. Picking one is how this stops
      // matching silently the day the deprecated tail is finally removed — and a
      // filter that never matches is a check that passes forever, which is the exact
      // defect class this whole file is being hardened against.
      const details = args[0] || {};
      const isError =
        args[1] === 3 || args[1] === "error" || details.level === "error" || details.level === 3;
      if (!isError) return;
      const message = String(
        typeof args[2] === "undefined" ? (details.message ?? "") : args[2]
      ).slice(0, 300);
      if (smokeConsoleErrors.length < 20) smokeConsoleErrors.push(message);
      const allowed = SMOKE_OFFLINE && SMOKE_ALLOWED_CONSOLE_ERRORS.some((re) => re.test(message));
      if (!allowed && smokeUnexpectedConsoleErrors.length < 10) {
        smokeUnexpectedConsoleErrors.push(message);
      }
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
      expect: SMOKE_EXPECT,
      // ASSERTED by the caller against desktop/package.json (run-smoke.mjs), which is
      // the point: a stale win-unpacked next to a bumped package.json would otherwise
      // pass for the tag being released.
      appVersion: app.getVersion(),
      // Reported so a typo in the profile switch cannot silently share the real
      // %APPDATA%\CueIQ profile — which would make "cold boot" a claim about
      // whatever the last run left behind.
      userDataPath: app.getPath("userData"),
    };
    let verdict = { ok: false, ...context, error: loadError ?? "no result" };
    try {
      if (loadError) throw new Error(loadError);
      // A run with nothing to expect can only ask the weakest question there is —
      // did anything render — which the login screen answers yes to on a boot that
      // failed at everything this test is for. It used to be merely unlikely (all
      // three scenarios happen to set the variable); it is now impossible.
      if (!SMOKE_EXPECT) {
        throw new Error("CUEIQ_SMOKE_EXPECT is empty: a smoke run must name the screen it expects");
      }
      // Now that a renderer exists, flip navigator.onLine — BEFORE the reload
      // below, so the boot actually under test begins already offline.
      //
      // The reading taken right here used to be reported as `onLineAfterCut` and
      // asserted nowhere. Deleted rather than asserted: it measures the document that
      // is about to be REPLACED by the reload below, and the emulation deliberately
      // does not survive that reload (see emulateOfflineViaCdp) — so the only reading
      // that can mean anything is the one taken from the boot under test, which is
      // probe.onLine, which onLineHeld does assert.
      if (SMOKE_OFFLINE && !SMOKE_HANDOVER) {
        smokeAt("cdp-offline");
        await emulateOfflineViaCdp(win);
      }

      // ── THE HANDOVER: online first, and the app writes its own caches ────────
      // Phase 1 boots ONLINE against the stub with nothing but a session planted, so
      // every cueiq:cache entry the offline phase then reads was written by the
      // app's own code on its own reads. That is the half of the founder's airplane
      // test that hand-seeding can never cover, and the half where a wrong cache KEY
      // (derived from the account's viewable groups) hides.
      let handover = null;
      /** The two-device driver's report — what this device was before and after the
       *  other one joined. Null in every single-device scenario. */
      let liveResult = null;
      if (SMOKE_HANDOVER) {
        if (SMOKE_SIGN_IN) {
          // Nothing is planted at all on this path: the app signs itself in against
          // the stub, and every cueiq:cache entry the offline phase reads is one it
          // produced from its own reads with its own token.
          smokeAt("handover:signing-in");
          const creds = JSON.parse(SMOKE_SIGN_IN);
          await signInThroughTheForm(win, creds.loginId, creds.password);
        } else if (SMOKE_SEED_FILE) {
          smokeAt("handover:seeding-session");
          await plantSmokeSeed(win);
        }
        smokeAt("handover:online");
        handover = await pollUntilCachesWritten(win, 30_000);
        if (!handover.ok) {
          throw new Error(
            `the online phase never wrote its caches — localStorage held [${handover.keys.join(", ")}]. ` +
              `Either the stub did not answer a read the app needs, or the sign-in it was given was not honoured.`
          );
        }
        // NOW cut it, and only now.
        smokeAt("handover:cutting");
        blockNetworkRequestsForSmoke(win);
        await emulateOfflineViaCdp(win);
        smokeAt("handover:offline-boot");
        await reloadAndWait(win, "into the offline boot");
      } else if (SMOKE_LIVE) {
        // ── THE TWO-DEVICE SCENARIO ──────────────────────────────────────────
        // Online throughout, and two of these processes running at once. Sign in
        // the same way the handover does — nothing planted, the real form — then
        // hand over to the role driver, which opens the show and either runs it or
        // joins it. Everything it learns rides the verdict for the runner to
        // compare ACROSS the two processes, because the interesting facts (one
        // controller, one sound host, one item index) are not visible to either
        // device alone.
        if (!SMOKE_SIGN_IN) throw new Error("CUEIQ_SMOKE_LIVE needs CUEIQ_SMOKE_SIGN_IN");
        if (SMOKE_AUDIO_FILE) {
          // Same shape as the socket patch below, and for the same reason: it only
          // applies to documents created after it is installed, so the app has to
          // boot once more on top of it. Nothing is lost — nobody has signed in yet.
          smokeAt("live:audible:watching-for-players");
          await registerAudioElementsViaCdp(win);
        }
        if (SMOKE_REALTIME) {
          // Before the sign-in, and therefore before any channel is opened: the
          // patched constructor only applies to documents created after it is
          // installed, so the app has to boot once more on top of it. Nothing is
          // lost in that reload — nothing has been planted and nobody has signed in.
          smokeAt(`live:${SMOKE_LIVE}:pointing-the-socket-at-the-stub`);
          await patchWebSocketHostViaCdp(win, SMOKE_BACKEND_FOR, SMOKE_BACKEND);
        }
        if (SMOKE_AUDIO_FILE || SMOKE_REALTIME) {
          await reloadAndWait(win, "with the smoke's page patches installed");
        }
        smokeAt(`live:${SMOKE_LIVE}:signing-in`);
        const creds = JSON.parse(SMOKE_SIGN_IN);
        await signInThroughTheForm(win, creds.loginId, creds.password);
        if (SMOKE_AUDIO_FILE) {
          // Before driveLiveScenario, because that function opens Live Mode and the
          // cache restore is one of its mount effects. Planting afterwards would be
          // planting into a page that had already looked.
          if (!SMOKE_LIVE_ITEM) throw new Error("CUEIQ_SMOKE_AUDIO_FILE needs CUEIQ_SMOKE_LIVE_ITEM");
          smokeAt("live:audible:planting-the-file");
          await seedAudioForSmoke(win, SMOKE_LIVE_EVENT, SMOKE_LIVE_ITEM);
        }
        liveResult = await driveLiveScenario(win);
      } else if (SMOKE_SEED_FILE) {
        smokeAt("seeding");
        await plantSmokeSeed(win);
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
      //
      // The ONLINE scenarios probe too, and that is not symmetry for its own sake:
      // "rejected" is only evidence of a cut if the same request would have resolved
      // without one. run-smoke.mjs reads the online run's answer as the calibration
      // for the offline run's, so a probe URL that has quietly stopped being
      // reachable at all shows up as a named failure instead of as a permanently
      // satisfied assertion.
      smokeAt("net-probe");
      const netProbe = SMOKE_PROBE_URL
        ? await probeTheNetwork(win, SMOKE_OFFLINE ? "rejected" : "resolved")
        : null;
      smokeAt("verdict");
      // No probe URL ⇒ nothing was proven. An offline scenario must not pass on that.
      const cutHeld = SMOKE_OFFLINE
        ? !!netProbe && netProbe.main === "rejected" && netProbe.renderer === "rejected"
        : true;
      // navigator.onLine was collected from the very first version of this test and
      // never once asserted on. It is not decoration: it is the ONLY signal that
      // separates the airplane test from the black-holed-wifi test, because
      // cache.ts's isOffline() is what gates the cache-first branch in workspace.ts,
      // events-list.ts, event-bundle.ts and run-order.ts. Measured, not reasoned: I
      // disabled emulateOfflineViaCdp and the airplane scenario passed, green, with
      // onLine: true in its own verdict — exercising the app's ONLINE path while
      // filing the result under "offline". The reported field is now the asserted one.
      const onLineHeld = !SMOKE_OFFLINE || probe.onLine === false;
      const consoleClean = smokeUnexpectedConsoleErrors.length === 0;
      const failReason = !cutHeld
        ? netProbe
          ? "the network cut did not hold"
          : "no probe URL: the network cut was never calibrated, so nothing was proven"
        : !onLineHeld
          ? "navigator.onLine stayed true: this ran the black-holed-wifi path, not the airplane one"
          : !consoleClean
            ? `unexpected console error(s): ${smokeUnexpectedConsoleErrors.join(" | ")}`
            : null;
      verdict = {
        ok: smokeExpectationMet(probe) && cutHeld && onLineHeld && consoleClean,
        ...context,
        ...probe,
        netProbe,
        // The keys the APP wrote during the online phase — reported so a green
        // handover run says WHAT it handed over, not merely that it did.
        ...(handover ? { cacheKeysWrittenOnline: handover.keys } : {}),
        // The two-device report. The runner cross-checks the pair — one controller,
        // one sound host, the same item — which is the only place that comparison
        // can happen: neither process can see the other's screen.
        ...(liveResult ? { liveRole: liveResult.role, liveReport: liveResult } : {}),
        ...(failReason ? { failReason } : {}),
        consoleErrors: smokeConsoleErrors,
        unexpectedConsoleErrors: smokeUnexpectedConsoleErrors,
      };
    } catch (e) {
      verdict = {
        ok: false,
        ...context,
        error: String(e),
        consoleErrors: smokeConsoleErrors,
        unexpectedConsoleErrors: smokeUnexpectedConsoleErrors,
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
    // ⚠️ THE INNER DEADLINE MUST ALWAYS FIRE FIRST. Three timeouts are nested here —
    // this watchdog, run-smoke.mjs's per-scenario `--timeout`, and the workflow step's
    // `timeout-minutes` — and only the innermost one can say WHY (it carries `stage`).
    // If the outer one wins, CI reports "no verdict" for a run the app was about to
    // explain. That ordering used to be a coincidence between two hardcoded numbers
    // 30s apart, and 30s is not much: this timer only starts at whenReady, so every
    // second Electron spends getting there (a cold, throttled, first-run CI runner
    // unpacking a 100 MB binary) is charged to the caller's clock and not to this one.
    // run-smoke.mjs now derives both from one constant and passes this half in, so the
    // gap is a fixed 45s of margin that cannot drift apart in a later edit.
    const watchdog = setTimeout(() => {
      writeSmokeVerdict({
        ok: false,
        failReason: `watchdog: no verdict within ${Math.round(SMOKE_WATCHDOG_MS / 1000)}s`,
      });
    }, SMOKE_WATCHDOG_MS);
    // Do not hold the process open on the watchdog alone.
    if (typeof watchdog.unref === "function") watchdog.unref();
  }
  // Deliberately NOT awaited: the update prompt is parentless, so it needs no
  // window — and awaiting the page load would let a failed load take both the
  // updater and the activate handler down with it.
  // ⚠️ THE CATCH IS FOR THE SELF-TEST ONLY, and the else-branch that used to sit
  // beside it was the one change in the smoke work that touched a NORMAL launch —
  // for the worse. `console.log` on a GUI-subsystem .exe goes nowhere: Windows
  // attaches no console to it, so a corrupt install (dist/index.html missing —
  // precisely the failure this smoke machinery exists to catch) showed the operator
  // a dark rectangle forever and said nothing, anywhere. Left UNCAUGHT, the same
  // rejection reaches Electron's default handler and puts up "A JavaScript error
  // occurred in the main process" naming ERR_FILE_NOT_FOUND — ugly, and infinitely
  // better than silence at a venue. Production behaviour restored exactly.
  //
  // Under SMOKE the opposite is right: a throw here must become the verdict FILE, or
  // the caller waits out its whole timeout for an answer this process already has.
  // That verdict (like the watchdog's) carries no context block — see the echo-check
  // in run-smoke.mjs, which must not overwrite this failReason with its own.
  if (SMOKE) {
    createWindow().catch((e) =>
      writeSmokeVerdict({ ok: false, failReason: "createWindow threw", error: String(e) })
    );
  } else {
    createWindow();
  }
  initAutoUpdate();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopShowPowerSaveBlocker(); // no window left to run a show from
  if (process.platform !== "darwin") app.quit();
});
