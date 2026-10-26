import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// 2026-10-26 final hunt — two main-process rules for a RUNNING show. Source reads, the
// same way desktop/src/components/update-feed.test.ts pins main.cjs: it cannot be
// imported (it boots Electron) and a "fix that never runs" was Round 10's commonest defect.
//
// 1. A quit made mid-show must not run the Windows installer. autoInstallOnAppQuit
//    installs a downloaded update on ANY quit; NSIS then runs silently and removes the
//    old files before installing, under the operator's quick relaunch to carry the show
//    on. The two quits a show ends in — the "ออกเลย" box and the crash-loop box — hold it.
// 2. The "unresponsive" box has no parent window. On macOS a parentless box is
//    APP-MODAL and freezes the show's clicks and keyboard cues once the renderer
//    recovers, so it goes through backgroundNotice (silent while a show runs).

const main = fs.readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");

/** A top-level function, to its closing brace at column 0 (CRLF or LF checkout). */
const fnBody = (name: string) => {
  const at = main.indexOf(name);
  expect(at, name).toBeGreaterThan(-1);
  const end = main.slice(at).search(/\r?\n\}\r?\n/);
  return main.slice(at, at + end);
};
/** A `win.webContents.on(...)` handler inside createWindow, to its `  });`. */
const handler = (event: string) => {
  const at = main.indexOf(`win.webContents.on("${event}"`);
  expect(at, event).toBeGreaterThan(-1);
  const end = main.slice(at).search(/\r?\n {2}\}\);\r?\n/);
  return main.slice(at, at + end);
};

describe("main.cjs — a quit made during a show never starts the installer", () => {
  it("holdInstallForShowQuit turns install-on-quit off, and only on Windows", () => {
    const fn = fnBody("function holdInstallForShowQuit()");
    expect(fn).toContain("if (!winUpdater) return;");
    expect(fn).toContain("winUpdater.autoInstallOnAppQuit = false;");
  });

  it("'ออกเลย' over a running show holds it before letting the close through", () => {
    const h = handler("will-prevent-unload");
    const leave = h.indexOf("if (choice === 1)");
    expect(leave).toBeGreaterThan(-1);
    const branch = h.slice(leave);
    const hold = branch.indexOf('if (updateBusyReason() === "show") holdInstallForShowQuit();');
    expect(hold).toBeGreaterThan(-1);
    expect(branch.indexOf("event.preventDefault()")).toBeGreaterThan(hold);
  });

  it("the crash-loop box holds it when the crashes took a running show down", () => {
    const h = handler("render-process-gone");
    // busy is read BEFORE the two resets that would hide the show
    const read = h.indexOf('updateBusyReason() === "show"');
    expect(read).toBeGreaterThan(-1);
    expect(h.indexOf("stopShowPowerSaveBlocker()")).toBeGreaterThan(read);
    expect(h.indexOf("unloadReason = null")).toBeGreaterThan(read);
    const loop = h.slice(h.indexOf("recentReloads.length >= MAX_RELOADS_PER_WINDOW"));
    const hold = loop.indexOf("holdInstallForShowQuit()");
    expect(hold).toBeGreaterThan(-1);
    expect(loop.indexOf("dialog.showMessageBox(")).toBeGreaterThan(hold);
  });

  it("a box answered for a reload (the app lives on) gives install-on-quit back", () => {
    expect(handler("did-start-navigation")).toContain("releaseInstallHold()");
    const fn = fnBody("function releaseInstallHold()");
    expect(fn).toContain("if (!installHeldForShowQuit || !winUpdater) return;");
    expect(fn).toContain("winUpdater.autoInstallOnAppQuit = true;");
  });
});

describe("main.cjs — the 'unresponsive' box never freezes a show", () => {
  it("goes through backgroundNotice, never a bare parentless showMessageBox", () => {
    const h = handler("unresponsive");
    expect(h).toContain("backgroundNotice(");
    expect(h).not.toMatch(/dialog\s*\.showMessageBox\(/);
  });
});

// ตาที่ 3 (2026-10-26): the show's reason and power blocker die WITH a crashed, wedged or
// reloading renderer, so a quit made then (the window closed on a hung page, or during the
// reload after a crash) still installed. `showUnended` remembers the show until the
// renderer itself lets go of it, and the last window's close holds the install for it.
describe("main.cjs — a show that never ended holds the installer on the last window's close", () => {
  // (2026-10-27) …and a page that never armed the "show" reason (a Live viewer) lets go
  // with set-show-running(false); behaviour pinned in main-show-install-hold.test.ts.
  it("is set when a show runs and cleared only by the renderer letting go", () => {
    expect(main).toContain("if (running) showUnended = true;");
    expect(main).toMatch(/if \(reason === "show"\) \{\s*showUnended = true;/);
    expect(main).toContain("} else if (reason === null) letGoOfShow();");
    expect(main).toContain("else if (!showReasonArmed) letGoOfShow();");
  });

  it("window-all-closed holds the install BEFORE the quit it triggers", () => {
    const at = main.indexOf('app.on("window-all-closed"');
    expect(at).toBeGreaterThan(-1);
    const body = main.slice(at, at + 400);
    const hold = body.indexOf(
      'if (showUnended || showCrashed || updateBusyReason() === "show") holdInstallForShowQuit();'
    );
    expect(hold).toBeGreaterThan(-1);
    expect(hold).toBeLessThan(body.indexOf("app.quit()"));
    expect(hold).toBeLessThan(body.indexOf("stopShowPowerSaveBlocker()"));
  });
});
