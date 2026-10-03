// The Mac's in-app update, step by step (main.cjs drives it; see update-feed.cjs for why the
// Mac cannot use Squirrel.Mac). No Electron imports: every step takes what it needs as an
// argument, so desktop/src/components/mac-update.test.ts runs it in plain Node and
// desktop/scripts/mac-update-smoke.mjs runs it for real on the CI Mac against the .dmg that
// is about to be published.
//
//   1. download()      — the .dmg, streamed to disk, its sha512 and size checked against
//                        latest-mac.yml before it is kept
//   2. stageFromDmg()  — mount it read-only, copy CueIQ.app out, unmount; the copy must say
//                        the expected version and pass `codesign --verify`
//   3. spawnInstaller()— as the app quits (main calls it from will-quit), a detached /bin/sh
//                        copies the new bundle NEXT TO the old one and checks it (version +
//                        codesign), waits for this process to exit, refuses to go on if the
//                        old app was reopened meanwhile, then swaps them with two renames
//                        (moving the old one back if the second fails), writes "ok" /
//                        "fail:<step>" to a result file and reopens the app. The next launch
//                        reads the result (main.cjs finishPendingMacUpdate).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");

/** execFile as a promise; rejects with the tool's stderr in the message. Every call has a
 *  timeout: a hung hdiutil would otherwise leave the chip on "downloading 100%" for good. */
function run(cmd, args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err && err.killed) reject(new Error(`${cmd} ${args[0] ?? ""} timed out after ${timeoutMs / 1000} s`));
      else if (err) reject(new Error(`${cmd} ${args[0] ?? ""} failed: ${String(stderr || err.message).trim()}`));
      else resolve(String(stdout));
    });
  });
}

/**
 * Stream `url` to `dest`, hashing as it goes. Resolves with `dest` only when the bytes are
 * exactly the ones latest-mac.yml describes; anything else deletes the partial file and
 * rejects. A connection that delivers nothing for `stallMs` is abandoned (venue Wi-Fi).
 */
async function download({ url, dest, sha512, size, fetch, onProgress = () => {}, stallMs = 60_000 }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + ".part";
  const abort = new AbortController();
  let stall = setTimeout(() => abort.abort(), stallMs);
  const poke = () => {
    clearTimeout(stall);
    stall = setTimeout(() => abort.abort(), stallMs);
  };
  const out = fs.createWriteStream(part);
  // A full disk surfaces as an 'error' EVENT; unheard, it would take the main process down.
  let writeError = null;
  out.on("error", (e) => {
    writeError = e;
    abort.abort();
  });
  const hash = crypto.createHash("sha512");
  let got = 0;
  let shown = -1;
  try {
    const res = await fetch(url, { cache: "no-store", signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`download answered ${res.status}`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      poke();
      const buf = Buffer.from(value);
      got += buf.length;
      if (got > size) throw new Error(`download is larger than the ${size} bytes the feed lists`);
      hash.update(buf);
      if (!out.write(buf)) {
        await new Promise((r) => {
          out.once("drain", r);
          out.once("error", r);
        });
      }
      if (writeError) throw writeError;
      const pct = Math.floor((got / size) * 100);
      if (pct !== shown) onProgress((shown = pct));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (writeError) throw writeError;
    if (got !== size) throw new Error(`download is ${got} bytes, the feed lists ${size}`);
    if (hash.digest("base64") !== sha512) throw new Error("download does not match the feed's sha512");
    fs.renameSync(part, dest);
    return dest;
  } catch (e) {
    await new Promise((r) => {
      if (out.closed) return r();
      out.once("close", r);
      out.destroy();
    });
    try {
      fs.rmSync(part, { force: true });
    } catch {
      /* a leftover .part is overwritten by the next attempt */
    }
    if (writeError) throw writeError;
    throw abort.signal.aborted ? new Error(`download stalled for ${Math.round(stallMs / 1000)} s`) : e;
  } finally {
    clearTimeout(stall);
  }
}

/** CFBundleShortVersionString of an .app, or null. */
function bundleVersion(appPath) {
  try {
    const plist = fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8");
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Mount `dmg`, copy its .app to `<workDir>/stage/`, unmount (always, even after a failed
 * copy). Resolves with the staged .app path once it says `expectVersion` and its signature
 * verifies — a half-copied or wrong bundle never reaches the swap.
 */
async function stageFromDmg({ dmg, workDir, expectVersion, exec = run }) {
  const mnt = path.join(workDir, "mnt");
  const stageDir = path.join(workDir, "stage");
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(mnt, { recursive: true });
  fs.mkdirSync(stageDir, { recursive: true });
  await exec("hdiutil", ["attach", dmg, "-nobrowse", "-noautoopen", "-readonly", "-mountpoint", mnt], 180_000);
  let staged;
  try {
    const name = fs.readdirSync(mnt).find((n) => n.endsWith(".app"));
    if (!name) throw new Error("no .app inside the .dmg");
    staged = path.join(stageDir, name);
    await exec("ditto", [path.join(mnt, name), staged], 600_000);
  } finally {
    await exec("hdiutil", ["detach", mnt, "-force"], 60_000).catch(() => {});
  }
  const v = bundleVersion(staged);
  if (v !== expectVersion) throw new Error(`the .dmg holds version ${v}, expected ${expectVersion}`);
  await exec("codesign", ["--verify", "--deep", staged], 300_000);
  return staged;
}

/**
 * The swap, as a shell script: it must outlive the app it replaces. Positional args:
 *   $1 pid to wait for · $2 installed .app · $3 staged .app · $4 result file
 *   $5 "1" = reopen · $6 the version the staged bundle must say
 * Every path that `rm -rf` touches is derived from $2/$3 and must end in ".app" — checked
 * first, so a bad argument stops the script instead of deleting something else.
 * The slow part (copying ~250 MB) happens BEFORE the old app has exited, beside it in the
 * same folder; after the exit only two renames remain, so there is no window in which a
 * Dock click can start the old bundle and then have it pulled out from under it — and if
 * one did start it anyway, pgrep sees it and the swap is called off.
 */
const INSTALL_SCRIPT = `#!/bin/sh
# CueIQ in-app update (desktop/electron/mac-update.cjs): replace the app once it has quit.
PID="$1"; APP="$2"; NEW="$3"; RESULT="$4"; REOPEN="$5"; VERSION="$6"
case "$APP" in /*.app) ;; *) printf 'fail:bad-path\\n' > "$RESULT"; exit 1 ;; esac
case "$NEW" in /*.app) ;; *) printf 'fail:bad-path\\n' > "$RESULT"; exit 1 ;; esac
TMP="$APP.updating"
OLD="$APP.previous"
finish() {
  printf '%s\\n' "$1" > "$RESULT"
  if [ "$REOPEN" = 1 ]; then open "$APP"; fi
  exit "$2"
}
# 1. copy + check the new bundle beside the old one while the old app is still quitting
FAIL=""
rm -rf "$TMP" "$OLD"
if [ -e "$TMP" ] || [ -e "$OLD" ]; then FAIL=fail:stale
elif ! ditto "$NEW" "$TMP"; then FAIL=fail:copy
elif ! grep -A1 '<key>CFBundleShortVersionString</key>' "$TMP/Contents/Info.plist" | grep -q "<string>$VERSION</string>"; then FAIL=fail:verify
elif ! codesign --verify --deep "$TMP" >/dev/null 2>&1; then FAIL=fail:verify
fi
if [ -n "$FAIL" ]; then rm -rf "$TMP"; fi
# 2. wait for the old app to exit — also before reporting a failure above, so a reopen
#    never lands on an app that is still quitting (still running: no reopen at all)
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 300 ]; then rm -rf "$TMP"; printf 'fail:still-running\\n' > "$RESULT"; exit 1; fi
  sleep 0.2
done
sleep 0.5
if [ -n "$FAIL" ]; then finish "$FAIL" 1; fi
if pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1; then rm -rf "$TMP"; printf 'fail:relaunched\\n' > "$RESULT"; exit 1; fi
# 3. two renames
if ! mv "$APP" "$OLD"; then rm -rf "$TMP"; finish fail:move-old 1; fi
if ! mv "$TMP" "$APP"; then mv "$OLD" "$APP"; rm -rf "$TMP"; finish fail:move-new 1; fi
rm -rf "$OLD" "$NEW"
finish ok 0
`;

/** Write the script into `workDir` and start it detached; it outlives this process. */
function spawnInstaller({ workDir, pid, app, staged, resultFile, reopen, version }) {
  const script = path.join(workDir, "install.sh");
  fs.writeFileSync(script, INSTALL_SCRIPT, { mode: 0o755 });
  fs.rmSync(resultFile, { force: true });
  const child = spawn("/bin/sh", [script, String(pid), app, staged, resultFile, reopen ? "1" : "0", version], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

module.exports = { download, bundleVersion, stageFromDmg, INSTALL_SCRIPT, spawnInstaller, run };
