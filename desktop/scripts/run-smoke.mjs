// Launches the PACKAGED app, three times, and asserts what each boot arrived at.
//
//   node desktop/scripts/run-smoke.mjs --exe <path-to-CueIQ.exe>
//   node desktop/scripts/run-smoke.mjs --exe <path-to-CueIQ.exe> --only airplane
//
// …or, to iterate WITHOUT packaging — and on a dev box whose Application Control
// policy refuses a freshly built unsigned .exe, which is this project's Windows
// machine — point --exe at electron itself and --app at the project:
//
//   node desktop/scripts/run-smoke.mjs \
//     --exe desktop/node_modules/electron/dist/electron.exe --app desktop
//
// That runs the SAME main.cjs against the SAME vite build from the same file://
// origin; only app.isPackaged differs, and nothing asserted here depends on it.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Until now CI's only check of the packaged app booted it with NO ACCOUNT and the
// NETWORK UP and asserted that #root had children — a bar the login screen clears.
// The condition that actually costs shows is the opposite one: a laptop opened at
// a venue with no internet, hours after it was last online. That is the founder's
// airplane test, and it has caught a real shipped bug before (under file:// the
// @supabase/ssr cookie session was unreadable, so every query ran as anon and a
// cold boot bounced to login). Scenario "airplane" below is that test, run by a
// machine — and writing it found a second one: loadWorkspace awaited getUser()
// with no timeout, so a joined-but-dead venue wifi parked the Shell on its
// spinner forever with the whole cache sitting on disk.
//
// ── WHAT IT DOES NOT PROVE — read this before quoting a green run ────────────
// Seeding cueiq:cache:* BYPASSES the code that writes those caches, so this proves
// the offline READ path and the boot gate, not that an online session filled the
// cache correctly before the wifi died. And it runs win-unpacked, not the
// NSIS-installed app, so install-only failures (paths with spaces or Thai
// characters, per-user install quirks) stay unproven.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSmokeSeed, SMOKE_EVENT_COUNT, SMOKE_TENANT_NAME } from "./make-smoke-seed.mjs";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const exe = arg("exe");
const appDir = arg("app");
const only = arg("only");
const timeoutSec = Number(arg("timeout", "120"));

if (!exe || !fs.existsSync(exe)) {
  console.error(`::error::run-smoke: no executable at ${exe || "<--exe not given>"}`);
  process.exit(2);
}

const SCENARIOS = [
  {
    name: "control",
    // No account, network UP. The app must reach the LOGIN screen — not merely
    // render something. This is also half of the cross-check at the bottom.
    what: "no session, network up -> the login screen",
    env: { CUEIQ_SMOKE_EXPECT: "signed-out" },
    seed: false,
  },
  {
    name: "airplane",
    // THE ONE THAT MATTERS. An expired session in localStorage, DNS dead, the
    // renderer's requests cancelled, navigator.onLine false — and the app must
    // still come up signed in, on the dashboard, showing the cached band and the
    // exact number of cached shows.
    what: "expired session + no network -> the signed-in dashboard, from cache",
    env: {
      CUEIQ_SMOKE_OFFLINE: "1",
      CUEIQ_SMOKE_EXPECT: "signed-in",
      CUEIQ_SMOKE_EXPECT_TENANT: SMOKE_TENANT_NAME,
      CUEIQ_SMOKE_EXPECT_EVENTS: String(SMOKE_EVENT_COUNT),
    },
    seed: true,
  },
  {
    name: "quick-show-offline",
    // The break-glass runner every other screen's fallback points at: no account,
    // no network, still has to open. Nothing verified this in a packaged build.
    what: "no session, no network, /my-show -> Quick Show opens anyway",
    env: {
      CUEIQ_SMOKE_OFFLINE: "1",
      CUEIQ_SMOKE_EXPECT: "quick-show",
      CUEIQ_SMOKE_HASH: "/my-show",
    },
    seed: false,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runScenario(s) {
  // A FRESH profile per scenario. Without it the second launch inherits the first
  // one's localStorage and IndexedDB, so "cold boot" would be a lie and a later
  // scenario could pass on leftovers rather than on what it was given.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `cueiq-smoke-${s.name}-`));
  const verdictFile = path.join(work, "verdict.json");
  const userDataDir = path.join(work, "userData");
  fs.mkdirSync(userDataDir);

  const env = { ...process.env, CUEIQ_SMOKE: "1", CUEIQ_SMOKE_OUT: verdictFile, ...s.env };
  if (s.seed) {
    const seedFile = path.join(work, "seed.json");
    fs.writeFileSync(seedFile, JSON.stringify(buildSmokeSeed()), "utf8");
    env.CUEIQ_SMOKE_SEED_FILE = seedFile;
  }

  console.log(`\n── smoke[${s.name}] ${s.what}`);
  const argv = appDir
    ? [appDir, `--user-data-dir=${userDataDir}`]
    : [`--user-data-dir=${userDataDir}`];
  const child = spawn(exe, argv, { env, stdio: "ignore", windowsHide: true });
  let spawnError = null;
  child.on("error", (e) => {
    spawnError = e;
  });

  // The verdict FILE is the channel, not the exit code: a GUI-subsystem .exe on
  // Windows has no console to print to and can hand the shell back before it is done.
  const deadline = Date.now() + timeoutSec * 1000;
  while (!fs.existsSync(verdictFile) && Date.now() < deadline && !spawnError) {
    await sleep(500);
  }
  try {
    child.kill();
  } catch {
    /* already gone */
  }

  if (spawnError) {
    return { name: s.name, ok: false, failReason: `could not launch: ${spawnError.message}` };
  }
  if (!fs.existsSync(verdictFile)) {
    // A hang gets a NAMED failure rather than a missing file, so "no verdict" can
    // never be confused with "this scenario was never run".
    return { name: s.name, ok: false, failReason: `no verdict within ${timeoutSec}s` };
  }

  let verdict;
  try {
    verdict = JSON.parse(fs.readFileSync(verdictFile, "utf8"));
  } catch (e) {
    return { name: s.name, ok: false, failReason: `unreadable verdict: ${String(e)}` };
  }
  console.log(JSON.stringify(verdict, null, 2));

  // main.cjs can only report which profile it resolved; only the caller knows which
  // one it asked for. A switch that silently did not take would make every claim
  // about a cold boot a claim about the previous run's leftovers instead.
  if (verdict.userDataPath && path.resolve(verdict.userDataPath) !== path.resolve(userDataDir)) {
    return {
      ...verdict,
      name: s.name,
      ok: false,
      failReason: `ran in profile ${verdict.userDataPath}, not the fresh one`,
    };
  }
  return { ...verdict, name: s.name };
}

const chosen = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
if (chosen.length === 0) {
  console.error(`::error::run-smoke: no scenario named "${only}"`);
  process.exit(2);
}

const results = [];
for (const s of chosen) results.push(await runScenario(s));

// Count first, evaluate second. A scenario that never launched would otherwise
// simply not be checked, and the job would go green having run fewer tests than it
// claims to have run.
if (results.length !== chosen.length) {
  console.error(
    `::error::run-smoke: expected ${chosen.length} verdicts, got ${results.length} ` +
      `(${results.map((r) => r.name).join(", ")})`
  );
  process.exit(1);
}

let failed = false;
for (const r of results) {
  if (r.ok) {
    console.log(`smoke[${r.name}]: PASS (screen=${r.screen}, route=${r.hash || "<none>"})`);
    continue;
  }
  failed = true;
  console.error(
    `::error::smoke[${r.name}]: ${r.failReason || "did not reach " + r.expect} ` +
      `(screen=${r.screen ?? "?"}, route=${r.hash || "<none>"}, loginVisible=${r.loginVisible}, ` +
      `tenant=${r.tenantName ?? "?"}, events=${r.eventRows ?? "?"}, onLine=${r.onLine}, ` +
      `stage=${r.stage ?? "?"}, error=${r.error || "none"})`
  );
}

// THE CROSS-CHECK, and it is what stops this whole file from passing vacuously.
// Every way the seed can fail to arrive — a wrong project ref, unparsed JSON, a
// localStorage write that threw, a reload that lost it — has exactly ONE symptom:
// a signed-OUT app. Which is precisely what the control scenario expects. So if the
// two boots land on the same screen, something is wrong no matter which screen it is.
const control = results.find((r) => r.name === "control");
const airplane = results.find((r) => r.name === "airplane");
if (control && airplane && control.screen && control.screen === airplane.screen) {
  failed = true;
  console.error(
    `::error::run-smoke: the control boot and the airplane boot both ended on "${control.screen}". ` +
      `The seed cannot have taken effect, so the offline scenario proved nothing.`
  );
}

if (failed) process.exit(1);
console.log(`\nsmoke: all ${results.length} scenario(s) passed`);
