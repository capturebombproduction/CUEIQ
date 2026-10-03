// The Mac's in-app update, run for real on the CI Mac that just built the .dmg files
// (.github/workflows/desktop-build.yml, macOS leg). desktop/scripts/mac-update.test.ts covers
// the logic with stand-in tools on Linux; THIS is the only place the real hdiutil, ditto and
// codesign touch the real build before พี่'s Mac does:
//
//   1. latest-mac.yml lists every .dmg with the size and sha512 it really has
//   2. download() over HTTP gets this Mac's .dmg and keeps it — and refuses it under a
//      wrong hash (the check proves it can fail, in the same run)
//   3. stageFromDmg() mounts it, copies CueIQ.app out, and the copy verifies
//   4. the swap script replaces an "installed" app once its process has exited, and the
//      result still passes `codesign --verify --deep` (an arm64 Mac will not run it otherwise)
//   5. a folder it may not write leaves the installed app whole
//
//   node desktop/scripts/mac-update-smoke.mjs desktop/release
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const mac = require("../electron/mac-update.cjs");
const feed = require("../electron/update-feed.cjs");

const releaseDir = path.resolve(process.argv[2] ?? "desktop/release");
const fail = (msg) => {
  console.error(`::error::mac update smoke: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`  ✓ ${msg}`);
const sha512 = (file) => crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== "darwin") fail("runs on macOS only (hdiutil, ditto, codesign)");

// 1 ── the feed describes the files ──────────────────────────────────────────────────
const ymlPath = path.join(releaseDir, "latest-mac.yml");
if (!fs.existsSync(ymlPath)) fail(`${ymlPath} missing — installed Macs would have nothing to update from`);
const parsed = feed.parseFeedYml(fs.readFileSync(ymlPath, "utf8"));
const version = JSON.parse(fs.readFileSync(path.join(releaseDir, "..", "package.json"), "utf8")).version;
if (!parsed || parsed.version !== version) fail(`latest-mac.yml says ${parsed?.version}, package.json ${version}`);
for (const arch of ["arm64", "x64"]) {
  const asset = feed.macAssetFor(parsed, arch);
  if (!asset) fail(`latest-mac.yml has no entry for ${arch}`);
  const file = path.join(releaseDir, asset.url);
  if (!fs.existsSync(file)) fail(`${asset.url} listed but not built`);
  if (fs.statSync(file).size !== asset.size) fail(`${asset.url}: size differs from the feed`);
  if (sha512(file) !== asset.sha512) fail(`${asset.url}: sha512 differs from the feed`);
}
ok(`latest-mac.yml ${version}: both .dmg files match their listed size and sha512`);

// 2 ── download over HTTP, the way the app does ──────────────────────────────────────
const asset = feed.macAssetFor(parsed, process.arch);
const server = http.createServer((req, res) => {
  const file = path.join(releaseDir, decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1)));
  if (!file.startsWith(releaseDir) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-length": fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;
// realpath: /var is a symlink to /private/var, and hdiutil reports mounts by the real path
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "CueIQ-update-smoke-")));
let dmg;
try {
  const progress = [];
  dmg = await mac.download({
    url: base + encodeURIComponent(asset.url),
    dest: path.join(work, asset.url),
    sha512: asset.sha512,
    size: asset.size,
    fetch,
    onProgress: (p) => progress.push(p),
  });
  if (progress.at(-1) !== 100) fail(`download progress ended at ${progress.at(-1)}`);
  ok(`downloaded ${asset.url} (${(asset.size / 1e6).toFixed(1)} MB) and its sha512 matched`);
  const refused = await mac
    .download({
      url: base + encodeURIComponent(asset.url),
      dest: path.join(work, "wrong.dmg"),
      sha512: crypto.createHash("sha512").update("not the dmg").digest("base64"),
      size: asset.size,
      fetch,
    })
    .then(() => false, () => true);
  if (!refused || fs.existsSync(path.join(work, "wrong.dmg"))) fail("a wrong sha512 was not refused");
  ok("the same download under a wrong sha512 was refused and left nothing");
} finally {
  server.close();
}

// 3 ── stage from the real .dmg ──────────────────────────────────────────────────────
const staged = await mac.stageFromDmg({ dmg, workDir: work, expectVersion: version });
const mounts = execFileSync("hdiutil", ["info"], { encoding: "utf8" });
if (mounts.includes(path.join(work, "mnt"))) fail("the .dmg is still mounted after staging");
ok(`staged ${path.basename(staged)} ${mac.bundleVersion(staged)} (codesign verified, .dmg unmounted)`);

// 4 ── the swap, against an "installed" old app whose process is still running ────────
function fakeInstalled(dir) {
  const app = path.join(dir, "CueIQ.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    "<plist><dict><key>CFBundleShortVersionString</key><string>0.0.1</string></dict></plist>"
  );
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "OLD"), "old");
  return app;
}
async function swap(appsDir, { lock = false } = {}) {
  const app = fakeInstalled(appsDir);
  // the swap deletes the staged copy it is given: hand it a copy of our one
  const stagedCopy = path.join(work, `run-${Date.now()}`, "CueIQ.app");
  execFileSync("ditto", [staged, stagedCopy]);
  const resultFile = path.join(work, `result-${Date.now()}.txt`);
  if (lock) fs.chmodSync(appsDir, 0o555);
  try {
    const old = spawn("sleep", ["2"]); // stands in for the old app, still quitting
    const oldExit = new Promise((r) => old.on("exit", r));
    mac.spawnInstaller({ workDir: path.dirname(stagedCopy), pid: old.pid, app, staged: stagedCopy, resultFile, reopen: false });
    await sleep(1000);
    const swappedEarly = !fs.existsSync(path.join(app, "Contents", "MacOS", "OLD"));
    await oldExit;
    for (let i = 0; i < 300 && !fs.existsSync(resultFile); i++) await sleep(100);
    const result = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, "utf8").trim() : null;
    return { app, result, swappedEarly };
  } finally {
    if (lock) fs.chmodSync(appsDir, 0o755);
    fs.rmSync(path.dirname(stagedCopy), { recursive: true, force: true });
  }
}

const apps = path.join(work, "Applications");
fs.mkdirSync(apps);
const s = await swap(apps);
if (s.swappedEarly) fail("the swap touched the installed app while its process was still running");
if (s.result !== "ok") fail(`swap result: ${s.result}`);
if (mac.bundleVersion(s.app) !== version) fail(`installed app says ${mac.bundleVersion(s.app)} after the swap`);
if (fs.existsSync(path.join(s.app, "Contents", "MacOS", "OLD"))) fail("old bundle content survived the swap");
const debris = fs.readdirSync(apps).filter((n) => n !== "CueIQ.app");
if (debris.length) fail(`swap left ${debris.join(", ")} behind`);
execFileSync("codesign", ["--verify", "--deep", "--verbose=2", s.app], { stdio: "inherit" });
ok(`swap waited for the old process, installed ${version}, left no debris, signature still valid`);

// 5 ── a folder it may not write: nothing lost ───────────────────────────────────────
const locked = path.join(work, "Locked");
fs.mkdirSync(locked);
const r = await swap(locked, { lock: true });
if (!String(r.result).startsWith("fail:")) fail(`a read-only folder answered ${r.result}`);
if (!fs.existsSync(path.join(r.app, "Contents", "MacOS", "OLD"))) fail("the old app was damaged by a failed swap");
if (fs.readdirSync(locked).join() !== "CueIQ.app") fail(`a failed swap left ${fs.readdirSync(locked).join(", ")}`);
ok(`a read-only folder: ${r.result}, the installed app untouched`);

fs.rmSync(work, { recursive: true, force: true });
console.log("mac update smoke: all steps passed");
