import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// 2026-11-05, hunt 13 - the PA laptop killed hard mid-show, and a renderer killed from outside.
//
// 1. Chromium commits localStorage to the disk on a delay - five seconds, then about once a
//    minute (measured on Electron 45: killed after 100 s of writes, the value read back was
//    40 s old). Live's and Quick Show's crash snapshot lives there, so a hard kill (Task
//    Manager, a blue screen, the power button) came back with the show as it stood up to a
//    minute before: the row before, no show after a START, a show running after จบโชว์. While
//    a show runs, main now flushes the window's storage every couple of seconds, once more
//    when the show stops, and on before-quit / session-end.
// 2. render-process-gone ignored "killed" as if it were our own kill - main.cjs never kills
//    its renderer, and one killed from outside (measured: reason "killed", exit code 1) left a
//    black window and a dead show. It reloads now like any crash, unless the app is quitting,
//    and the crash-loop guard still stops a renderer that keeps dying.
// Pinned against the REAL code run in a sandbox (main.cjs boots Electron and cannot be imported).

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
  advance: (ms: number) => void;
  appEvent: (ev: string) => void;
  winEvent: (ev: string) => void;
  gone: (reason: string) => void;
  /** The page refused to unload (a show runs): main asks; 0 = อยู่ต่อ, 1 = ออกเลย. */
  unloadAsked: (choice: number) => void;
  readonly flushes: number;
  readonly reloads: number;
  readonly boxes: number;
  readonly timers: number;
};

function buildSandbox(): Sandbox {
  // the power blocker's block: the helpers it uses live between it and its neighbour
  const blocker = slice("let powerSaveBlockerId = null;", /\r?\n\/\/ A hidden window is a background page/);
  const registerIpc = slice("function registerIpc() {", /\r?\n\}\r?\n/) + "\n}";
  const hold = slice("let installHeldForShowQuit = false;", /\r?\n\/\*\* Ask the feed/);
  const busy = slice("function updateBusyReason() {", /\r?\n\}\r?\n/) + "\n}";
  // from the crash bookkeeping to the end of the render-process-gone handler (and whatever
  // window handlers sit between them)
  const crash = slice("  let recentReloads = [];", /\r?\n {2}\/\/ "Unresponsive"/);
  // the leave-a-running-show question, which a quit runs into first
  const unload = slice('  win.webContents.on("will-prevent-unload"', /\r?\n {2}\}\);\r?\n/) + "\n  });";
  const src = `
    let now = 1_000_000;
    const Date = { now: () => now };
    let nextTimer = 1;
    const timers = new Map();
    function setInterval(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms, at: now + ms }); return id; }
    function clearInterval(id) { timers.delete(id); }
    function advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        now = next[1].at;
        next[1].at += next[1].ms;
        next[1].fn();
      }
      now = end;
    }
    let flushes = 0;
    const session = { defaultSession: { flushStorageData: () => { flushes++; } } };
    let blockerOn = false;
    const powerSaveBlocker = {
      start: () => { blockerOn = true; return 7; },
      stop: () => { blockerOn = false; },
      isStarted: () => blockerOn,
    };
    const handlers = {};
    const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
    const appHandlers = {};
    const app = { on: (ev, fn) => { appHandlers[ev] = fn; }, quit() {} };
    let unloadReason = null;
    function setShowThrottling() {}
    function fetchAudioBytes() {} function putAudioBytes() {} function pickAudioFile() {}
    function checkForUpdates() {} function applyUpdate() {}
    let updateState = {};
    const winUpdater = { autoInstallOnAppQuit: true };
    const process = { platform: "win32" };
    const console = { log() {} };
    let reloads = 0;
    let boxes = 0;
    let unloadChoice = 0;
    let macReopen = false;
    const dialog = {
      showMessageBox: () => { boxes++; return Promise.resolve({ response: 0 }); },
      showMessageBoxSync: () => unloadChoice,
    };
    const reloadToLastKnownUrl = () => { reloads++; return Promise.resolve(); };
    const winHandlers = {};
    const contentsHandlers = {};
    const win = {
      on: (ev, fn) => { winHandlers[ev] = fn; },
      isDestroyed: () => false,
      webContents: { on: (ev, fn) => { contentsHandlers[ev] = fn; } },
    };
    ${blocker}
    ${busy}
    ${hold}
    ${registerIpc}
    registerIpc();
    ${crash}
    ${unload}
    const sender = { isDestroyed: () => false, setBackgroundThrottling() {} };
    return {
      send: (ch, arg) => handlers[ch]?.({ sender }, arg),
      advance,
      appEvent: (ev) => appHandlers[ev]?.(),
      winEvent: (ev) => winHandlers[ev]?.(),
      gone: (reason) => contentsHandlers["render-process-gone"]({}, { reason, exitCode: 1 }),
      unloadAsked: (choice) => { unloadChoice = choice; contentsHandlers["will-prevent-unload"]({ preventDefault() {} }); },
      get flushes() { return flushes; },
      get reloads() { return reloads; },
      get boxes() { return boxes; },
      get timers() { return timers.size; },
    };
  `;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(src)() as Sandbox;
}

describe("main.cjs — while a show runs, its storage reaches the disk at once", () => {
  it("a running show is flushed every couple of seconds, and once more when it stops", () => {
    const s = buildSandbox();
    s.send("cueiq:set-show-running", true);
    s.advance(60_000);
    // ~every 2 s: never a minute's worth of the show only in memory
    expect(s.flushes).toBeGreaterThanOrEqual(25);
    const during = s.flushes;
    s.send("cueiq:set-show-running", false);
    expect(s.flushes).toBe(during + 1);
    // and nothing after the show: no timer left behind
    s.advance(60_000);
    expect(s.flushes).toBe(during + 1);
    expect(s.timers).toBe(0);
  });

  it("no show, no timer", () => {
    const s = buildSandbox();
    s.advance(60_000);
    expect(s.flushes).toBe(0);
    expect(s.timers).toBe(0);
  });

  it("a second 'running' does not start a second timer", () => {
    const s = buildSandbox();
    s.send("cueiq:set-show-running", true);
    s.send("cueiq:set-show-running", true);
    expect(s.timers).toBe(1);
  });

  it("a quit and the end of the Windows session flush too", () => {
    const s = buildSandbox();
    s.appEvent("before-quit");
    expect(s.flushes).toBe(1);
    s.winEvent("query-session-end");
    s.winEvent("session-end");
    expect(s.flushes).toBe(3);
  });
});

describe("main.cjs — a renderer killed from outside comes back", () => {
  it("killed while the app is not quitting: reloaded, like a crash", () => {
    const s = buildSandbox();
    s.gone("killed");
    expect(s.reloads).toBe(1);
  });

  it("killed while the app quits (or the session ends): left alone", () => {
    const s = buildSandbox();
    s.appEvent("before-quit");
    s.gone("killed");
    expect(s.reloads).toBe(0);
    const t = buildSandbox();
    t.winEvent("session-end");
    t.gone("killed");
    expect(t.reloads).toBe(0);
  });

  // Argon on hunt 13: a quit turned down at the leave-the-show question left the app "quitting"
  // for good - a renderer killed from outside after that stayed a black window.
  it("a quit the operator turned down (อยู่ต่อ): a later kill is a crash again, and reloads", () => {
    const s = buildSandbox();
    s.appEvent("before-quit");
    s.unloadAsked(0);
    s.gone("killed");
    expect(s.reloads).toBe(1);
  });

  it("a quit the operator went on with (ออกเลย): the kill that follows is left alone", () => {
    const s = buildSandbox();
    s.appEvent("before-quit");
    s.unloadAsked(1);
    s.gone("killed");
    expect(s.reloads).toBe(0);
  });

  it("our own quit's clean-exit is still never reloaded", () => {
    const s = buildSandbox();
    s.gone("clean-exit");
    expect(s.reloads).toBe(0);
  });

  it("the crash-loop guard still stops a renderer that keeps getting killed", () => {
    const s = buildSandbox();
    for (let i = 0; i < 4; i++) s.gone("killed");
    expect(s.reloads).toBe(3);
    expect(s.boxes).toBe(1);
  });
});
