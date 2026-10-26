import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";

// 2026-10-27 desktop hunt — when a quit may run the Windows installer, around a show.
//
// autoInstallOnAppQuit installs a downloaded update on ANY quit, and a quit made around a
// show is the start of the operator's quick relaunch (NSIS removes the old files before
// laying down the new ones). main.cjs holds the install for such a quit (showUnended,
// 4fdb9a6). Pinned here, against the REAL handler bodies run in a sandbox (main.cjs boots
// Electron and cannot be imported):
//
// 1. The latch must not outlive the show. A Live Mode VIEWER (sound off) sends
//    setShowRunning(true/false) but never arms the "show" unload reason - its guard is
//    gated on sound or control - so it never sent the null that cleared showUnended either.
//    Every later ordinary quit, hours after, then skipped the installer.
// 2. A render crash caught by the error boundary unmounts Live / Quick Show, whose
//    cleanups send that same "show over" - so the close from the error screen ran the
//    installer mid-show. The renderer now says "crashed" (cueiq:show-crashed); main keeps
//    it until a show runs again, in whichever order the crash word and the cleanups land.
// 3. The "ready to restart" box defaults to "ไว้ทีหลัง": it takes the focus, Live open but
//    not started is not "busy", and the operator's START key is Space.

const main = fs.readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");

function slice(startNeedle: string, endRe: RegExp): string {
  const at = main.indexOf(startNeedle);
  expect(at, startNeedle).toBeGreaterThan(-1);
  const end = main.slice(at).search(endRe);
  expect(end, startNeedle).toBeGreaterThan(-1);
  return main.slice(at, at + end);
}

type Sandbox = {
  send: (channel: string, arg?: unknown) => void;
  quit: () => void;
  winUpdater: { autoInstallOnAppQuit: boolean };
  quitCalled: number;
};

function buildSandbox(): Sandbox {
  const registerIpc = slice("function registerIpc() {", /\r?\n\}\r?\n/) + "\n}";
  const hold = slice("let installHeldForShowQuit = false;", /\r?\n\/\*\* Ask the feed/);
  const busy = slice("function updateBusyReason() {", /\r?\n\}\r?\n/) + "\n}";
  const wac = slice('app.on("window-all-closed", () => {', /\r?\n\}\);/) + "\n});";
  const src = `
    const handlers = {};
    const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
    let powerSaveBlockerId = null;
    let unloadReason = null;
    function setShowThrottling() {}
    function startShowPowerSaveBlocker() { powerSaveBlockerId = 1; }
    function stopShowPowerSaveBlocker() { powerSaveBlockerId = null; }
    function fetchAudioBytes() {} function putAudioBytes() {} function pickAudioFile() {}
    function checkForUpdates() {} function applyUpdate() {}
    let updateState = {};
    const winUpdater = { autoInstallOnAppQuit: true };
    let quitCalled = 0;
    const appHandlers = {};
    const app = { on: (ev, fn) => { appHandlers[ev] = fn; }, quit: () => { quitCalled++; } };
    const process = { platform: "win32" };
    const console = { log() {} };
    ${busy}
    ${hold}
    ${registerIpc}
    registerIpc();
    ${wac}
    const sender = { isDestroyed: () => false, setBackgroundThrottling() {} };
    return {
      // a channel main does not handle is a word that never arrives
      send: (ch, arg) => handlers[ch]?.({ sender }, arg),
      quit: () => appHandlers["window-all-closed"](),
      winUpdater,
      get quitCalled() { return quitCalled; },
    };
  `;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(src)() as Sandbox;
}

/** The last window closed: did that quit leave the installer free to run? */
function quitInstalls(s: Sandbox): boolean {
  s.quit();
  expect(s.quitCalled).toBe(1);
  return s.winUpdater.autoInstallOnAppQuit;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("main.cjs — the show latch ends with the show", () => {
  it("control: Live controller / Quick Show (reason show → null) installs on a later quit", () => {
    const s = buildSandbox();
    s.send("cueiq:set-unload-reason", "show");
    s.send("cueiq:set-show-running", true);
    s.send("cueiq:set-show-running", false);
    s.send("cueiq:set-unload-reason", null);
    expect(quitInstalls(s)).toBe(true);
  });

  it("a viewer whose watched show ended does not hold the next ordinary quit", () => {
    const s = buildSandbox();
    // live-mode.tsx wake-lock effect: begun && !showEnded → setShowRunning(true); no reason
    s.send("cueiq:set-show-running", true);
    // the controller pressed จบโชว์ / the viewer left Live → setShowRunning(false)
    s.send("cueiq:set-show-running", false);
    expect(quitInstalls(s)).toBe(true);
  });

  it("control: a controller's จบโชว์ (power blocker off, still in Live) keeps holding", () => {
    const s = buildSandbox();
    s.send("cueiq:set-unload-reason", "show");
    s.send("cueiq:set-show-running", true);
    s.send("cueiq:set-show-running", false); // จบโชว์ - the reason is still armed
    expect(quitInstalls(s)).toBe(false);
  });

  it("control: a viewer quitting while the show still runs holds it", () => {
    const s = buildSandbox();
    s.send("cueiq:set-show-running", true);
    expect(quitInstalls(s)).toBe(false);
  });
});

describe("main.cjs — a render crash during a show holds the installer", () => {
  it("the crash word first, then the unmounted show's cleanups", () => {
    const s = buildSandbox();
    s.send("cueiq:set-unload-reason", "show");
    s.send("cueiq:set-show-running", true);
    s.send("cueiq:show-crashed");
    s.send("cueiq:set-unload-reason", null);
    s.send("cueiq:set-show-running", false);
    expect(quitInstalls(s)).toBe(false);
  });

  it("the cleanups first, then the crash word moments later", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const s = buildSandbox();
    s.send("cueiq:set-show-running", true);
    s.send("cueiq:set-unload-reason", "show");
    s.send("cueiq:set-show-running", false);
    s.send("cueiq:set-unload-reason", null);
    now.mockReturnValue(1_000_050);
    s.send("cueiq:show-crashed");
    expect(quitInstalls(s)).toBe(false);
  });

  it("control: a crash with no show around it holds nothing", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const s = buildSandbox();
    s.send("cueiq:set-unload-reason", "show");
    s.send("cueiq:set-unload-reason", null); // a show ended…
    now.mockReturnValue(1_000_000 + 10 * 60_000);
    s.send("cueiq:show-crashed"); // …ten minutes before an unrelated crash
    expect(quitInstalls(s)).toBe(true);
  });

  it("control: once a show runs again after the crash, its own end frees the next quit", () => {
    const s = buildSandbox();
    s.send("cueiq:set-unload-reason", "show");
    s.send("cueiq:set-show-running", true);
    s.send("cueiq:show-crashed");
    s.send("cueiq:set-unload-reason", null);
    s.send("cueiq:set-show-running", false);
    // โหลดใหม่: the show restores, runs, and is ended by the operator
    s.send("cueiq:set-unload-reason", "show");
    s.send("cueiq:set-show-running", true);
    s.send("cueiq:set-show-running", false);
    s.send("cueiq:set-unload-reason", null);
    expect(quitInstalls(s)).toBe(true);
  });

  it("the renderer can say it: the preload exposes the channel main handles", () => {
    const preload = fs.readFileSync(path.resolve(__dirname, "../electron/preload.cjs"), "utf8");
    expect(preload).toContain('showCrashed: () => ipcRenderer.invoke("cueiq:show-crashed")');
    expect(main).toContain('ipcMain.handle("cueiq:show-crashed"');
  });
});

describe("main.cjs — the restart box never restarts on a stray key", () => {
  it("offerRestart's default (and cancel) button is ไว้ทีหลัง", () => {
    const fn = slice("async function offerRestart()", /\r?\n\}\r?\n/);
    expect(fn).toContain('buttons: ["เปิดใหม่เลย", "ไว้ทีหลัง"]');
    expect(fn).toContain("defaultId: 1,");
    expect(fn).toContain("cancelId: 1,");
    expect(fn).toContain("if (response === 0) await installUpdate();");
  });

  it("the launch box's default (and cancel) button is ไว้ก่อน (Space = START)", () => {
    const fn = slice("async function promptAtLaunch(version)", /\r?\n\}\r?\n/);
    expect(fn).toContain('buttons: ["อัปเดตเลย", "ไว้ก่อน"]');
    expect(fn).toContain("defaultId: 1,");
    expect(fn).toContain("cancelId: 1,");
  });
});
