// Pure helpers for the desktop's update control (main.cjs → the header's update chip).
// No Electron imports, so desktop/src/components/update-feed.test.ts loads it in plain Node.
//
// Windows updates through electron-updater (the NSIS feed, latest.yml). macOS cannot use
// Squirrel.Mac: it only accepts an Apple-signed app and ours is ad-hoc signed. So the Mac
// updates ITSELF (desktop/electron/mac-update.cjs): it reads latest-mac.yml — which the build
// writes next to the .dmg files (desktop/build/rename-mac-arch.cjs), version + each .dmg's
// sha512 — downloads its .dmg, checks it, and swaps the app bundle once the app has quit.
// When that is not possible (a release without latest-mac.yml, an app run from the .dmg or
// outside a writable folder) the press opens the .dmg instead, as before.

/** = desktop/package.json build.win.publish (owner/repo). */
const REPO = "capturebombproduction/CUEIQ";
/** GitHub redirects /releases/latest/download/<asset> to the newest published release. */
const LATEST_YML_URL = `https://github.com/${REPO}/releases/latest/download/latest.yml`;
const LATEST_MAC_YML_URL = `https://github.com/${REPO}/releases/latest/download/latest-mac.yml`;

/** "0.1.24" / "v0.1.24" → [0, 1, 24]; anything else → null. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is `latest` strictly newer than `current`? Unreadable versions never are. */
function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The `version:` line of electron-builder's latest.yml. */
function versionFromLatestYml(text) {
  const m = /^version:\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$/m.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/** The release's file name for a Mac (desktop/build/rename-mac-arch.cjs names them). An
 *  Intel build running under Rosetta on an Apple-Silicon Mac is offered the Apple-Silicon
 *  one: that is the machine it is on. */
function macDmgName(version, arch, underRosetta = false) {
  const flavour = arch === "arm64" || underRosetta ? "Apple-Silicon" : "Intel";
  return `CueIQ-${version}-Mac-${flavour}.dmg`;
}

/** A file of release `v<version>`. */
function releaseAssetUrl(version, name) {
  return `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(name)}`;
}

/** The .dmg a Mac should download for `version`. */
function macDmgUrl(version, arch, underRosetta = false) {
  return releaseAssetUrl(version, macDmgName(version, arch, underRosetta));
}

/**
 * latest-mac.yml, in electron-builder's own layout (the same shape as latest.yml):
 *   version: 0.1.26
 *   files:
 *     - url: CueIQ-0.1.26-Mac-Apple-Silicon.dmg
 *       sha512: <base64>
 *       size: 123
 *   releaseDate: '…'
 */
function macFeedYml({ version, files, releaseDate }) {
  const lines = [`version: ${version}`, "files:"];
  for (const f of files) {
    lines.push(`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`);
  }
  lines.push(`releaseDate: '${releaseDate}'`);
  return lines.join("\n") + "\n";
}

/** { version, files: [{ url, sha512, size }] } from a feed, or null if it is not one. Every
 *  file must carry all three fields: an entry without a hash cannot be checked, so it is
 *  dropped rather than downloaded on trust. */
function parseFeedYml(text) {
  const version = versionFromLatestYml(text);
  if (!version) return null;
  const files = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    let m;
    if ((m = /^\s*-\s*url:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(raw))) {
      cur = { url: m[1], sha512: null, size: null };
      files.push(cur);
    } else if (cur && (m = /^\s+sha512:\s*['"]?([A-Za-z0-9+/=]+)['"]?\s*$/.exec(raw))) {
      cur.sha512 = m[1];
    } else if (cur && (m = /^\s+size:\s*(\d+)\s*$/.exec(raw))) {
      cur.size = Number(m[1]);
    } else if (/^\S/.test(raw)) {
      cur = null; // a top-level key ends the files list
    }
  }
  return { version, files: files.filter((f) => f.sha512 && f.size > 0) };
}

/** This Mac's entry in a parsed latest-mac.yml, or null. */
function macAssetFor(feed, arch, underRosetta = false) {
  if (!feed) return null;
  const name = macDmgName(feed.version, arch, underRosetta);
  return feed.files.find((f) => f.url === name) ?? null;
}

/** /Applications/CueIQ.app/Contents/MacOS/CueIQ → /Applications/CueIQ.app, else null. */
function macBundleFromExe(exePath) {
  const m = /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(exePath ?? ""));
  return m ? m[1] : null;
}

/**
 * Why this copy of the app cannot replace itself, or null if it can (writability is
 * checked by main against the real disk):
 *   "not-bundle"   — not a packaged .app
 *   "dmg"          — running straight off the mounted .dmg (read-only)
 *   "translocated" — macOS runs a not-yet-moved download from a random read-only copy
 *                    (App Translocation); moving the app into Applications ends it
 */
function macBundleBlocker(bundlePath) {
  if (!bundlePath) return "not-bundle";
  if (bundlePath.startsWith("/Volumes/")) return "dmg";
  if (bundlePath.includes("/AppTranslocation/")) return "translocated";
  return null;
}

/**
 * States in which the feed is read again by the long-running re-check. "available" is one
 * of them: the chip names the version it found when it last looked, and on a desk machine
 * that stays open that can be hours and releases ago - พี่'s Mac showed 0.1.29 while 0.1.30
 * was out, installed 0.1.29, and only the restart's check found 0.1.30 (2026-10-04: "มันอัพ
 * ทีละเวอชันไล่เลขไปเรื่อย ๆ ... กดสองรอบ"). Never while a download runs or one waits.
 */
const RECHECK_STATES = ["idle", "uptodate", "error", "available"];
function shouldRecheck(state) {
  return RECHECK_STATES.includes(state);
}

/**
 * The header chip's press (and Help → ตรวจหาอัปเดต's "อัปเดตเลย"). With an update on offer it
 * reads the feed AGAIN first and installs whatever is newest NOW - one press, however many
 * releases came out since the chip appeared; a failed or "nothing newer" re-check downloads
 * nothing (the chip shows that state). Nothing found yet → look; downloaded → install.
 * `state` is read after each await: the re-check changes it.
 */
async function pressUpdate({ state, recheck, download, install }) {
  const s = state();
  if (s === "error" || s === "uptodate" || s === "idle") return recheck();
  if (s === "available") {
    await recheck();
    if (state() === "available") await download();
    return;
  }
  if (s === "ready") await install();
}

/**
 * Mac: an in-app update of `latest` that already failed this session goes the .dmg route,
 * however often the feed is read again - its swap on the disk (`swapFailed`, { version,
 * dmg, result }) or its staging from the checked .dmg (`stageFailed`, { version, dmg }).
 * Returns { blocker, dmg } for that route, or null. Forgetting the staging failure on a
 * re-check (every press re-checks first - pressUpdate) sent each press to download the
 * same ~100 MB again and fail the same way, instead of opening the .dmg already on disk.
 */
function macFailedRoute(latest, swapFailed, stageFailed) {
  if (swapFailed && swapFailed.version === latest) {
    return { blocker: "swap-failed", dmg: swapFailed.dmg ?? null };
  }
  if (stageFailed && stageFailed.version === latest) {
    return { blocker: "stage", dmg: stageFailed.dmg ?? null };
  }
  return null;
}

module.exports = {
  REPO,
  LATEST_YML_URL,
  LATEST_MAC_YML_URL,
  parseVersion,
  isNewer,
  versionFromLatestYml,
  macDmgName,
  releaseAssetUrl,
  macDmgUrl,
  macFeedYml,
  parseFeedYml,
  macAssetFor,
  macBundleFromExe,
  macBundleBlocker,
  RECHECK_STATES,
  shouldRecheck,
  pressUpdate,
  macFailedRoute,
};
