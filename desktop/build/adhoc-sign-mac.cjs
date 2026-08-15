// electron-builder afterPack hook — AD-HOC SIGN the macOS .app.
//
// WHY THIS EXISTS. This project has no Apple Developer certificate, so the release
// workflow sets CSC_IDENTITY_AUTO_DISCOVERY=false and electron-builder skips code
// signing entirely. On an INTEL Mac that is merely inconvenient: Gatekeeper warns,
// the user runs `xattr -dr com.apple.quarantine`, and the app opens.
//
// On APPLE SILICON it is fatal. arm64 macOS refuses to execute a binary with NO
// signature at all — the kernel kills it — so the app either bounces in the Dock
// or reports itself as "damaged", and no amount of clearing the quarantine
// attribute helps. That is exactly what happened when the 0.1.9 .dmg was installed
// on a Mac (2026-08-15): the documented xattr step was followed and the app still
// would not open. The manual cure is `codesign --force --deep --sign -`, which is
// this hook, done once at build time so nobody has to run it.
//
// An AD-HOC signature ("-") is not a certificate and does not make the app
// trusted: it carries no identity, so Gatekeeper still asks the user to confirm an
// unidentified developer on first open, and the quarantine step in the release
// notes is still required. What it does is satisfy the arm64 loader, which is the
// difference between "a warning" and "cannot be opened at all".
//
// ⚠️ It also has to run BEFORE the .dmg is assembled, which is why this is
// afterPack and not afterAllArtifactBuild (that one runs on the finished
// artifacts, when signing the .app inside a built .dmg would change nothing).
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSignMac(context) {
  // mac only, and only when nothing else signed it. A real certificate, if this
  // project ever gets one, must not be overwritten by an ad-hoc signature —
  // electron-builder would have signed already, and re-signing with "-" would
  // strip the identity and undo notarization.
  if (context.electronPlatformName !== "darwin") return;
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY !== "false" && process.env.CSC_LINK) return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  // --deep signs the embedded frameworks and helpers too. It is deprecated for
  // real signing (each component should be signed on its own terms) and exactly
  // right for an ad-hoc pass, whose only job is that every Mach-O in the bundle
  // carries some signature.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
  // Verify rather than assume: a signature that did not take would ship a build
  // whose only symptom is an app that will not open on the founder's laptop —
  // which is the situation this hook exists to end, and it should not be able to
  // recur silently.
  execFileSync("codesign", ["--verify", "--verbose=2", appPath], { stdio: "inherit" });
  console.log(`[adhoc-sign-mac] ad-hoc signed ${appPath}`);
};
