// Pure helpers for the desktop's update control (main.cjs → the header's update chip).
// No Electron imports, so desktop/src/components/update-feed.test.ts loads it in plain Node.
//
// Windows updates through electron-updater (the NSIS feed, latest.yml). macOS cannot: an
// in-place Mac update (Squirrel.Mac) only accepts an Apple-signed app and ours is ad-hoc
// signed, so the Mac reads the version from the same latest.yml (one tag builds both) and
// offers the matching .dmg to download instead.

/** = desktop/package.json build.win.publish (owner/repo). */
const REPO = "capturebombproduction/CUEIQ";
/** GitHub redirects /releases/latest/download/<asset> to the newest published release. */
const LATEST_YML_URL = `https://github.com/${REPO}/releases/latest/download/latest.yml`;

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

/**
 * The .dmg a Mac should download for `version`. Names follow desktop/build/rename-mac-arch.cjs
 * (…-Mac-Apple-Silicon.dmg / …-Mac-Intel.dmg). An Intel build running under Rosetta on an
 * Apple-Silicon Mac is offered the Apple-Silicon one: that is the machine it is on.
 */
function macDmgUrl(version, arch, underRosetta = false) {
  const flavour = arch === "arm64" || underRosetta ? "Apple-Silicon" : "Intel";
  return `https://github.com/${REPO}/releases/download/v${version}/CueIQ-${version}-Mac-${flavour}.dmg`;
}

module.exports = { REPO, LATEST_YML_URL, parseVersion, isNewer, versionFromLatestYml, macDmgUrl };
