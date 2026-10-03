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
//   3. spawnInstaller()— once the app has quit (main calls it from will-quit), a detached
//                        /bin/sh waits for this process to exit, moves the old bundle aside,
//                        puts the new one in its place (moving the old one back if that
//                        fails), writes "ok" / "fail:<step>" to a result file and reopens
//                        the app. The next launch reads the result (main.cjs).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");

/** execFile as a promise; rejects with the tool's stderr in the message. */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args[0] ?? ""} failed: ${String(stderr || err.message).trim()}`));
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
  await exec("hdiutil", ["attach", dmg, "-nobrowse", "-noautoopen", "-readonly", "-mountpoint", mnt]);
  let staged;
  try {
    const name = fs.readdirSync(mnt).find((n) => n.endsWith(".app"));
    if (!name) throw new Error("no .app inside the .dmg");
    staged = path.join(stageDir, name);
    await exec("ditto", [path.join(mnt, name), staged]);
  } finally {
    await exec("hdiutil", ["detach", mnt, "-force"]).catch(() => {});
  }
  const v = bundleVersion(staged);
  if (v !== expectVersion) throw new Error(`the .dmg holds version ${v}, expected ${expectVersion}`);
  await exec("codesign", ["--verify", "--deep", staged]);
  return staged;
}

/**
 * The swap, as a shell script: it must outlive the app it replaces. Positional args:
 *   $1 pid to wait for · $2 installed .app · $3 staged .app · $4 result file · $5 "1" = reopen
 * Every path that `rm -rf` touches is derived from $2/$3 and must end in ".app" — checked
 * first, so a bad argument stops the script instead of deleting something else.
 */
const INSTALL_SCRIPT = `#!/bin/sh
# CueIQ in-app update (desktop/electron/mac-update.cjs): replace the app once it has quit.
PID="$1"; APP="$2"; NEW="$3"; RESULT="$4"; REOPEN="$5"
case "$APP" in /*.app) ;; *) printf 'fail:bad-path\\n' > "$RESULT"; exit 1 ;; esac
case "$NEW" in /*.app) ;; *) printf 'fail:bad-path\\n' > "$RESULT"; exit 1 ;; esac
TMP="$APP.updating"
OLD="$APP.previous"
finish() {
  printf '%s\\n' "$1" > "$RESULT"
  if [ "$REOPEN" = 1 ]; then open "$APP"; fi
  exit "$2"
}
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 300 ]; then printf 'fail:still-running\\n' > "$RESULT"; exit 1; fi
  sleep 0.2
done
sleep 0.5
rm -rf "$TMP" "$OLD"
if ! ditto "$NEW" "$TMP"; then rm -rf "$TMP"; finish fail:copy 1; fi
if ! mv "$APP" "$OLD"; then rm -rf "$TMP"; finish fail:move-old 1; fi
if ! mv "$TMP" "$APP"; then mv "$OLD" "$APP"; rm -rf "$TMP"; finish fail:move-new 1; fi
rm -rf "$OLD" "$NEW"
finish ok 0
`;

/** Write the script into `workDir` and start it detached; it outlives this process. */
function spawnInstaller({ workDir, pid, app, staged, resultFile, reopen }) {
  const script = path.join(workDir, "install.sh");
  fs.writeFileSync(script, INSTALL_SCRIPT, { mode: 0o755 });
  fs.rmSync(resultFile, { force: true });
  const child = spawn("/bin/sh", [script, String(pid), app, staged, resultFile, reopen ? "1" : "0"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

module.exports = { download, bundleVersion, stageFromDmg, INSTALL_SCRIPT, spawnInstaller, run };
