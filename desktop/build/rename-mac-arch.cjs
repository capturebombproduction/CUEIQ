// electron-builder afterAllArtifactBuild hook.
//
// The mac artifactName produces arch-coded files (CueIQ-<ver>-Mac-arm64.dmg /
// -Mac-x64.dmg). Band members don't know "arm64" vs "x64", so rename them to
// human-friendly platform names so the right download is obvious:
//   …-Mac-arm64.dmg -> …-Mac-Apple-Silicon.dmg   (M1/M2/M3/M4)
//   …-Mac-x64.dmg   -> …-Mac-Intel.dmg           (older Intel Macs)
//
// Then, on a Mac build, write latest-mac.yml beside them: the version and each .dmg's
// sha512 + size. That file is the Mac's update feed (desktop/electron/update-feed.cjs):
// the installed app downloads its .dmg and refuses it unless it matches these bytes. It
// is hashed HERE, after the rename, so it describes exactly the files the Release gets.
// (electron-builder writes its own latest-mac.yml only for a zip target, which this
// build does not have — if one is ever added, drop this part rather than race it.)
//
// Windows (.exe) is named natively via win.artifactName and is left untouched
// here (its path doesn't match the dmg patterns). Runs on every build (mac and
// win); a no-match path is returned unchanged.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { macFeedYml } = require("../electron/update-feed.cjs");

function sha512Base64(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha512");
    fs.createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("base64")))
      .on("error", reject);
  });
}

exports.default = async function renameMacArch(context) {
  const paths = context.artifactPaths.map((p) => {
    const renamed = p
      .replace(/-arm64\.dmg$/, "-Apple-Silicon.dmg")
      .replace(/-x64\.dmg$/, "-Intel.dmg");
    if (renamed !== p && fs.existsSync(p)) {
      fs.renameSync(p, renamed);
      console.log(`[rename-mac-arch] ${p} -> ${renamed}`);
      return renamed;
    }
    return p;
  });

  const dmgs = paths.filter((p) => /-Mac-(Apple-Silicon|Intel)\.dmg$/.test(p) && fs.existsSync(p));
  if (dmgs.length === 0) return paths;
  const version = require("../package.json").version;
  const files = [];
  for (const p of dmgs) {
    const name = path.basename(p);
    if (!name.startsWith(`CueIQ-${version}-`)) {
      throw new Error(`[rename-mac-arch] ${name} does not carry version ${version}`);
    }
    files.push({ url: name, sha512: await sha512Base64(p), size: fs.statSync(p).size });
  }
  const feed = path.join(path.dirname(dmgs[0]), "latest-mac.yml");
  fs.writeFileSync(feed, macFeedYml({ version, files, releaseDate: new Date().toISOString() }));
  console.log(`[rename-mac-arch] wrote ${feed} (${files.map((f) => f.url).join(", ")})`);
  return [...paths, feed];
};
