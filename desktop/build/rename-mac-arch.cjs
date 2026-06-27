// electron-builder afterAllArtifactBuild hook.
//
// The mac artifactName produces arch-coded files (CueIQ-<ver>-Mac-arm64.dmg /
// -Mac-x64.dmg). Band members don't know "arm64" vs "x64", so rename them to
// human-friendly platform names so the right download is obvious:
//   …-Mac-arm64.dmg -> …-Mac-Apple-Silicon.dmg   (M1/M2/M3/M4)
//   …-Mac-x64.dmg   -> …-Mac-Intel.dmg           (older Intel Macs)
//
// Windows (.exe) is named natively via win.artifactName and is left untouched
// here (its path doesn't match the dmg patterns). Runs on every build (mac and
// win); a no-match path is returned unchanged.
const fs = require("fs");

exports.default = async function renameMacArch(context) {
  return context.artifactPaths.map((p) => {
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
};
