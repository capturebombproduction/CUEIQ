// Launches the PACKAGED app — five scenarios, one of them TWO processes at once —
// and asserts what each boot arrived at.
//
//   node desktop/scripts/run-smoke.mjs --exe <path-to-CueIQ.exe>
//   node desktop/scripts/run-smoke.mjs --exe <path-to-CueIQ.exe> --only airplane
//
// …or, to iterate WITHOUT packaging — and on a dev box whose Application Control
// policy refuses a freshly built unsigned .exe, which is this project's Windows
// machine — point --exe at electron itself and --app at the project:
//
//   node desktop/scripts/run-smoke.mjs --app desktop
//
// (--exe is optional in that mode: the electron binary's location is asked of the
// electron package rather than written down here — see resolveElectron.)
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
// The seeding limitation this section used to lead with is CLOSED, and the sentence
// is kept so the closing is legible: "airplane" plants cueiq:cache entries by hand,
// which BYPASSES the code that writes them, so on its own it proves the offline read
// path and says nothing about whether an online session fills the cache correctly
// before the wifi dies. Scenario "handover" now covers that half: nothing is planted
// at all, the app types its own credentials into the real login form against a local
// stub of the Supabase API (desktop/scripts/smoke-backend.mjs, served to the renderer
// from the main process so the BUILD is untouched), makes its own reads, writes its
// own caches — and only then is the network cut and the app cold-booted on them.
// Both scenarios are kept: "airplane" is the faster, backend-free guard on the read
// path, "handover" is the end-to-end one.
//
// ── WHAT THE TWO-DEVICE SCENARIO DOES *NOT* PROVE ───────────────────────────
// It runs two REAL app processes against a REAL socket and settles a real
// arbitration between them, and it fails loudly when that arbitration breaks
// (verified by breaking it: the running-show rule in lib/live-arbitration.ts,
// inverted, turns a four-broadcast conversation into 391,150 and the pair goes
// red). What it is NOT: two machines. Both processes share one CPU, one clock and
// one loopback interface, so it says nothing about wall-clock skew between a
// laptop and a phone, about a wifi that drops one device and not the other, or
// about audio — no sound is decoded here, and "one sound host" is an assertion
// about a flag, not about a room. The physics still needs hands.
//
// Neither does it prove the INSTALLED app. On a `v*` tag desktop-build.yml runs this
// against desktop/release/win-unpacked/CueIQ.exe, which is the packaged tree but not
// the NSIS-installed one; on every push ci.yml runs it in --app mode against electron
// + the vite build, which is one step further out again. So install-only failures —
// paths with spaces or Thai characters, per-user install quirks, a file the installer
// forgets to copy — stay unproven in both.
//
// And the seeded session is honoured by the app's OWN localStorage scan
// (desktop/src/data/stored-session.ts matches any `sb-*-auth-token`), so a green
// airplane run does not by itself prove supabase-js recognised the entry and failed
// its refresh the way it would at a venue. What keeps that path faithful is that the
// seed's project ref is DERIVED from desktop/vite.config.ts rather than copied — see
// the comment on resolveSupabaseUrl in make-smoke-seed.mjs, which is there because a
// deliberately wrong ref passed this suite green.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  buildSmokeSeed,
  SMOKE_EVENT_COUNT,
  SMOKE_SUPABASE_URL,
  SMOKE_TENANT_NAME,
} from "./make-smoke-seed.mjs";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const exeArg = arg("exe");
const appDir = arg("app");
const only = arg("only");
const timeoutSec = Number(arg("timeout", "135"));

/**
 * Where electron's binary actually is — ASKED, not assumed.
 *
 * The first cut of the CI job hardcoded
 * `desktop/node_modules/electron/dist/electron.exe`, which is exactly where it sits
 * on this dev box and is nevertheless the wrong thing to write down: the location is
 * the electron package's business, and on a GitHub runner the file was simply not
 * there (that install finished in twelve seconds — too fast to have fetched a ~100 MB
 * binary at all). The job failed with "no executable at <a path I invented>", which
 * says nothing about why.
 *
 * `require("electron")` returns the absolute path the package itself recorded, and
 * when the postinstall did not run it throws a message that IS the diagnosis
 * ("Electron failed to install correctly…"). Both beat a guess.
 */
function resolveElectron() {
  if (exeArg) {
    if (fs.existsSync(exeArg)) return exeArg;
    console.error(`::error::run-smoke: no executable at ${exeArg}`);
    process.exit(2);
  }
  if (!appDir) {
    console.error("::error::run-smoke: give --exe <packaged app> or --app <project dir>");
    process.exit(2);
  }
  const from = path.resolve(appDir, "package.json");
  let resolved;
  try {
    resolved = createRequire(from)("electron");
  } catch (e) {
    console.error(
      `::error::run-smoke: could not resolve electron from ${appDir} — ${String(e).split("\n")[0]}\n` +
        `That message is usually electron's own: its postinstall did not run, so there is ` +
        `no binary to launch. Run \`node node_modules/electron/install.js\` in ${appDir}.`
    );
    process.exit(2);
  }
  if (typeof resolved !== "string" || !fs.existsSync(resolved)) {
    console.error(
      `::error::run-smoke: electron resolved to ${String(resolved)}, which does not exist.`
    );
    process.exit(2);
  }
  return resolved;
}

const exe = resolveElectron();

// The version the app under test MUST report. Read from desktop/package.json, which
// is the same file electron-builder stamps the installer and latest.yml from — so a
// win-unpacked left over from an earlier build, smoke-tested green for a tag it was
// not built from, is a mismatch here instead of a published Release whose contents
// are a version older than its own update feed says.
//
// ⚠️ AND IT IS INERT UNDER --app, WHICH IS THE MODE CI RUNS ON EVERY PUSH. `electron.exe
// desktop` makes app.getVersion() read desktop/package.json — the same file this
// constant is read from — so the two cannot disagree and the comparison below can only
// pass. (Confirmed by bumping package.json to 0.1.99 and watching a green run.) Nothing
// here can give it teeth in that mode: there is no second artifact to disagree with,
// because the app under test IS this source tree. It has teeth in exactly one place —
// the `v*` tag run in desktop-build.yml, where the thing launched is a separately built
// desktop/release/win-unpacked. So --app mode SAYS SO in the log (the ::notice:: below)
// instead of letting a green push log read as if a build's version had been checked.
const DESKTOP_VERSION = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

// ⚠️ ONE constant, two clocks. The app's own watchdog (main.cjs) is the only timer
// that can name a CAUSE — it carries the stage the run hung at — so it must always be
// the first to fire. It used to be a hardcoded 90s sitting 30s inside a hardcoded
// 120s here, which is not margin: the watchdog only starts at app.whenReady, so
// everything Electron spends before that (process spawn, a cold CI runner unpacking
// ~100 MB, Defender's first look at a fresh binary) is charged to THIS clock and not
// to that one. Thirty seconds of Windows-runner cold start would have inverted them
// and turned every explained hang into a bare "no verdict". Derive instead: the inner
// deadline is always exactly OUTER_MARGIN_SEC earlier, whatever --timeout is set to.
const OUTER_MARGIN_SEC = 45;
const watchdogMs = Math.max(15_000, (timeoutSec - OUTER_MARGIN_SEC) * 1000);

console.log(`run-smoke: launching ${exe}`);

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
    name: "handover",
    // THE OTHER HALF OF THE AIRPLANE TEST, and the limitation this file's header
    // used to describe as unfixed: "airplane" reads caches the TEST wrote, so it
    // proves the offline read path and says nothing about whether an ONLINE session
    // fills those caches correctly before the wifi dies.
    //
    // Here nothing is hand-seeded but the session. The app boots online against a
    // local stub of the Supabase API (desktop/scripts/smoke-backend.mjs, reached by
    // a main-process redirect so the BUILD is untouched), makes its own reads, and
    // writes its own cueiq:cache entries — including the events key, which is
    // derived from the account's viewable groups and is exactly the kind of thing
    // that goes quietly wrong. Only then is the network cut and the app cold-booted
    // on what it wrote.
    what: "online against a stub, app fills its OWN caches, THEN the network is cut",
    env: {
      CUEIQ_SMOKE_HANDOVER: "1",
      CUEIQ_SMOKE_OFFLINE: "1",
      CUEIQ_SMOKE_EXPECT: "signed-in",
      CUEIQ_SMOKE_EXPECT_TENANT: SMOKE_TENANT_NAME,
      CUEIQ_SMOKE_EXPECT_EVENTS: String(SMOKE_EVENT_COUNT),
    },
    // NOTHING is planted — not even the session. The app types its own credentials
    // into the real login form, which is also the first half of the venue story:
    // sign in at the hotel, drive to the show, lose the wifi.
    seed: false,
    backend: true,
  },
  {
    // TWO PROCESSES, ONE SHOW — and the only scenario here that is not about one
    // device. The remaining hand-run item this project has is พี่ standing in a
    // room with a laptop and a phone; its arbitration is unit-tested and its wiring
    // jsdom-tested, but nothing has ever run the two halves as two real apps over a
    // real socket. The worst bug this app shipped lived exactly there: a phone that
    // merely OPENED the live page could win the tie against a PA that had reloaded
    // mid-show, re-assert its own empty INITIAL state, and stop the music.
    //
    // This one is orchestrated separately (see runTwoDeviceScenario) because both
    // halves run at once and have to be sequenced against each other. The entry
    // stays in this table so `--only two-device` works and so a reader of the list
    // sees every scenario in one place.
    name: "two-device",
    what: "PA starts a show, a second device joins -> one controller, one sound host",
    // a = launched first and starts the show; b = joins mid-show. `controller`
    // names which of the two must END with the show, and everything the pair is
    // checked on is written in terms of that — so the handoff scenario below is the
    // same code with one letter changed, rather than a second copy of it.
    pair: {
      a: { role: "main", expect: "live-controller" },
      b: { role: "peer", expect: "live-viewer" },
      controller: "a",
    },
    seed: false,
    backend: true,
    // Most of this clock is spent WAITING: the PA holds while the peer signs in,
    // loads the bundle and settles its channel. The app's watchdog is derived from
    // this (see runScenario), so both move together.
    timeoutSec: 240,
    env: {
      CUEIQ_SMOKE_REALTIME: "1",
      CUEIQ_SMOKE_EXPECT: "live-controller", // per-device value; overridden below
    },
  },
  {
    // THE HANDOFF — "2-device handoff" is the exact phrase on the hand-run list.
    // The PA runs the show; the second device does what an operator does when the
    // desk moves: turns its OWN sound output on, then presses ขอควบคุม. The show,
    // the audio and the item index all have to move together and land on one
    // device — and the old PA has to go quiet, which is the half that has cost a
    // real show before (two speakers, one of them a second behind).
    //
    // The button it presses is not visible until the sound is on: live-mode.tsx
    // renders ขอควบคุม only for a device that is outputting, precisely so control
    // can never be taken by a muted phone. That rule is now exercised by a machine
    // pressing real buttons in a real window.
    name: "two-device-handoff",
    what: "the show, the audio and the control all move to the second device",
    pair: {
      a: { role: "main-yield", expect: "live-viewer" },
      b: { role: "peer-take", expect: "live-controller" },
      controller: "b",
    },
    seed: false,
    backend: true,
    timeoutSec: 240,
    env: {
      CUEIQ_SMOKE_REALTIME: "1",
      CUEIQ_SMOKE_EXPECT: "live-controller", // per-device value; overridden below
    },
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

async function runScenario(s, extraEnv = {}) {
  // A FRESH profile per scenario — and, in the two-device scenario, per DEVICE.
  // Without it the second launch inherits the first one's localStorage and
  // IndexedDB, so "cold boot" would be a lie and a later scenario could pass on
  // leftovers rather than on what it was given. It is also what lets two of these
  // run at once at all: app.requestSingleInstanceLock() keeps its lock file inside
  // userData, so two processes sharing a profile would be one process.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `cueiq-smoke-${s.name}-`));
  const verdictFile = path.join(work, "verdict.json");
  const userDataDir = path.join(work, "userData");
  fs.mkdirSync(userDataDir);

  // A scenario may buy itself more time (the two-device one spends most of its
  // clock WAITING for the other device), and the app's own watchdog has to move
  // with it — the inner deadline must always fire first, whatever the outer is.
  const scenarioTimeoutSec = s.timeoutSec ?? timeoutSec;
  const scenarioWatchdogMs = Math.max(15_000, (scenarioTimeoutSec - OUTER_MARGIN_SEC) * 1000);

  const env = {
    ...process.env,
    CUEIQ_SMOKE: "1",
    CUEIQ_SMOKE_OUT: verdictFile,
    CUEIQ_SMOKE_WATCHDOG_MS: String(scenarioWatchdogMs),
    // The host the app really talks to, derived from the same file the bundle bakes
    // it in from. main.cjs has NO default for this on purpose: its old fallback was
    // "https://example.invalid", a reserved TLD that can never resolve, so the
    // "prove the network is cut" probe answered "cut" with the network fully up.
    CUEIQ_SMOKE_PROBE_URL: SMOKE_SUPABASE_URL,
    ...s.env,
  };
  if (s.seed) {
    const seedFile = path.join(work, "seed.json");
    const options = typeof s.seed === "object" ? s.seed : {};
    fs.writeFileSync(seedFile, JSON.stringify(buildSmokeSeed(options)), "utf8");
    env.CUEIQ_SMOKE_SEED_FILE = seedFile;
  }

  Object.assign(env, extraEnv);

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
  const deadline = Date.now() + scenarioTimeoutSec * 1000;
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
    return { name: s.name, ok: false, failReason: `no verdict within ${scenarioTimeoutSec}s` };
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
  // ⚠️ EVERY CHECK BELOW READS THE CONTEXT BLOCK, so every check below must first ask
  // whether there is one. main.cjs writes exactly two verdicts without it — the
  // watchdog's and "createWindow threw" — and both are the app naming a cause nothing
  // out here can reconstruct. Comparing their absent `expect` against what we sent
  // tripped the echo-check on all of them and REPLACED the app's explanation with a
  // fabricated one ("the scenario's env did not arrive"), which is the reverse of a
  // diagnosis: main.cjs's own comment says the inner deadline is the only timer that
  // can say WHERE a run hung, and the caller was throwing that away. Reproduced with
  // CUEIQ_SMOKE_WATCHDOG_MS=8000, which is how it was found.
  if (!("expect" in verdict)) return { ...verdict, name: s.name };

  // Now the QUESTION, the same way the profile was checked above. main.cjs echoes back
  // the expectation and the offline flag it actually read, and until now nobody
  // compared them with what was sent — so any way the env fails to arrive (a spawn
  // that drops it, a shell that eats it, a scenario table edited to the wrong key)
  // would change what was tested while staying green. Two string compares close it.
  const wantExpect = s.env.CUEIQ_SMOKE_EXPECT;
  if (verdict.expect !== wantExpect) {
    return {
      ...verdict,
      name: s.name,
      ok: false,
      failReason: `asked for expect="${wantExpect}" but the app answered "${verdict.expect}" — the scenario's env did not arrive`,
    };
  }
  if (verdict.offline !== (s.env.CUEIQ_SMOKE_OFFLINE === "1")) {
    return {
      ...verdict,
      name: s.name,
      ok: false,
      failReason: `asked for offline=${s.env.CUEIQ_SMOKE_OFFLINE === "1"} but the app ran offline=${verdict.offline}`,
    };
  }
  // And WHICH BUILD answered. Reported since the first cut of this, asserted by
  // nobody: on a `v*` tag the thing being launched is desktop/release/win-unpacked,
  // which is whatever the last `npm run dist` left there — a build step that silently
  // did nothing would hand this suite an old tree to bless. Meaningful in THAT mode
  // only; under --app it is a tautology, announced as one above and in the log.
  if (verdict.appVersion !== DESKTOP_VERSION) {
    return {
      ...verdict,
      name: s.name,
      ok: false,
      failReason: `the app under test reports version ${verdict.appVersion}, but desktop/package.json says ${DESKTOP_VERSION} — a stale build is being smoke-tested`,
    };
  }
  return { ...verdict, name: s.name };
}

const chosen = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
if (chosen.length === 0) {
  console.error(`::error::run-smoke: no scenario named "${only}"`);
  process.exit(2);
}
// A scenario with no CUEIQ_SMOKE_EXPECT asks the weakest question there is — did
// anything render — which the login screen answers yes to on a boot that failed at
// everything this file is about. All three below happen to set it, which made that a
// latent trap for whoever adds the fourth; main.cjs now refuses such a run outright
// and this refuses to launch it in the first place, which is also where the message
// can name the scenario.
const mute = chosen.filter((s) => !s.env.CUEIQ_SMOKE_EXPECT);
if (mute.length > 0) {
  console.error(
    `::error::run-smoke: scenario(s) ${mute.map((s) => s.name).join(", ")} set no ` +
      `CUEIQ_SMOKE_EXPECT — a smoke run must name the screen it expects.`
  );
  process.exit(2);
}
if (appDir) {
  // Said out loud, in the log a reader of a green CI run actually sees, because the
  // verdict JSON printed below carries an appVersion and the check on it reads like a
  // check. In this mode it is not one — see the DESKTOP_VERSION comment above.
  console.log(
    `::notice::run-smoke: --app ${appDir} — this runs the SOURCE TREE via electron, not a ` +
      `packaged build. The appVersion assertion is INERT here (the app reads the very ` +
      `desktop/package.json this script compares it against, so it cannot disagree); only ` +
      `the v* tag run, against desktop/release/win-unpacked, tests a real build's version. ` +
      `Everything else below — the screens, the network cut, both cross-checks — is real.`
  );
}
if (only) {
  // --only is for iterating by hand. Said out loud because BOTH cross-checks at the
  // bottom need two scenarios, so a CI step that ever grows an --only silently drops
  // them and nobody reading a green log would know.
  console.log(
    `::warning::run-smoke: --only ${only} — the control/airplane cross-check and the ` +
      `network-cut calibration are both skipped.`
  );
}

// One verdict per scenario, and runScenario always returns one — a scenario that
// could not launch, timed out or wrote an unreadable file comes back as a NAMED
// failure rather than as a gap. (There used to be an `if (results.length !==
// chosen.length)` guard here, described as catching a scenario that never ran. A
// `for…of` that pushes exactly once per element cannot produce that, so it was a
// check that passes forever — the very thing this file's header is about — sitting
// in the file that says so. Deleted rather than made true: the property it wanted is
// already guaranteed by the loop, and a loop is easier to read than an assertion
// about one.)
/**
 * The two-device scenario: two apps, one stub, one show.
 *
 * Sequenced on rendezvous marks the stub holds, never on sleeps — the PA must
 * write its verdict AFTER the peer has joined, and the peer must join AFTER the
 * show is running. A sleep long enough to be safe on a cold runner is long enough
 * to be slow, and any sleep at all is the 2am-flake shape.
 *
 * Returns BOTH verdicts, and fails them as a PAIR: the interesting facts here —
 * exactly one controller, exactly one sound host, the same item index on both
 * screens — are invisible to either device alone, so they can only be checked out
 * here where both reports have arrived.
 */
async function runTwoDeviceScenario(s) {
  const { startSmokeBackend, SMOKE_WORLD } = await import("./smoke-backend.mjs");
  // realtime: true — the ONE scenario that gets a socket. Everything else here is
  // about an app with no network, where cancelling the upgrade is the honest thing.
  const backend = await startSmokeBackend({ realtime: true });
  const host = new URL(SMOKE_SUPABASE_URL).host;
  console.log(`   stub Supabase (with realtime) at ${backend.url}, standing in for ${host}`);

  const shared = {
    CUEIQ_SMOKE_BACKEND: backend.url,
    CUEIQ_SMOKE_BACKEND_FOR: host,
    CUEIQ_SMOKE_SIGN_IN: JSON.stringify({
      loginId: SMOKE_WORLD.auth.loginId,
      password: SMOKE_WORLD.auth.password,
    }),
    // The rich event — the only fixture show with a setlist. Live Mode refuses to
    // open on an empty one, which would fail this scenario for a reason that has
    // nothing to do with two devices.
    CUEIQ_SMOKE_LIVE_EVENT: SMOKE_WORLD.ids.richEvent,
    // Probe the STUB, not the real project. Every other scenario aims this at the
    // real Supabase host because it is asking "is the network cut"; this one runs
    // online and real DNS is dead for it by design (see the host-resolver block in
    // main.cjs), so aiming there would report a cut that says nothing about
    // anything. The stub answers /auth/v1/health with a 501 — a RESPONSE, which is
    // all "resolved" means.
    CUEIQ_SMOKE_PROBE_URL: backend.url,
  };
  // Same scenario, same build, same account: the ONLY difference is which role each
  // process plays and, therefore, what it expects to have become. Nothing about the
  // arbitration may depend on the test telling either side who should win.
  // ⚠️ A HYPHEN, not a colon. The name becomes a temp DIRECTORY (runScenario gives
  // every device its own profile), and ":" is illegal in a Windows path — which is
  // the platform the show laptop and this dev box both run.
  const device = ({ role, expect }) => ({
    ...s,
    name: `${s.name}-${role}`,
    what: `${s.what} — ${role}`,
    env: { ...s.env, CUEIQ_SMOKE_LIVE: role, CUEIQ_SMOKE_EXPECT: expect },
  });

  let main;
  let peer;
  try {
    // The device that starts the show, first and NOT awaited: it holds until the
    // second one has done its part.
    const mainRun = runScenario(device(s.pair.a), shared);
    let mainSettled = false;
    mainRun.then(() => {
      mainSettled = true;
    });

    // Wait for the show to be RUNNING before the second device exists — otherwise
    // the peer is not a device joining a show, it is a second device starting one,
    // which is a different (and much easier) test.
    const deadline = Date.now() + (s.timeoutSec ?? timeoutSec) * 1000;
    while (!backend.hasMark("main-started") && !mainSettled && Date.now() < deadline) {
      await sleep(250);
    }
    if (!backend.hasMark("main-started")) {
      // The PA died or hung before starting. Await its verdict so the failure that
      // gets reported is ITS explanation, not a fabricated one from out here.
      main = await mainRun;
      return [
        {
          ...main,
          ok: false,
          failReason:
            main.failReason ??
            `the PA never reported the show as started, so no second device was launched ` +
              `(error=${main.error ?? "none"})`,
        },
      ];
    }

    console.log("   the PA is running the show — launching the second device");
    peer = await runScenario(device(s.pair.b), shared);
    // Release the first device: it re-reads its own live state and writes its
    // verdict. In the HANDOFF scenario it is usually already released — the peer
    // sets "peer-took-control" itself the moment the show moves — and setting this
    // one anyway is what stops a peer that DIED mid-handoff from leaving the other
    // process hanging until its watchdog, which would report the wrong failure.
    backend.setMark("peer-settled");
    backend.setMark("peer-took-control");
    main = await mainRun;
  } finally {
    await backend.close();
  }

  // ── ANTI-VACUITY, first. Everything below is an assertion about the app; this is
  // an assertion about the test. If nothing crossed the socket, whatever the two
  // devices agreed on they agreed on somewhere else, and a green pair means
  // nothing at all.
  const relayed = backend.realtime?.broadcastsOf("state") ?? 0;
  const joins = (backend.realtime?.messages ?? []).filter((m) => m.event === "phx_join").length;
  const decodeErrors = (backend.realtime?.messages ?? []).filter(
    (m) => m.event === "DECODE_ERROR" || m.event === "PARSE_ERROR"
  );
  console.log(
    `   realtime: ${joins} channel join(s), ${relayed} live-state broadcast(s) relayed` +
      (decodeErrors.length ? `, ${decodeErrors.length} UNDECODABLE` : "")
  );
  const pairFailures = [];
  if (relayed === 0) {
    pairFailures.push(
      "no live-state broadcast was relayed between the two devices — they never talked, " +
        "so whatever they agreed on was not agreed through this test"
    );
  }
  // AND AN UPPER BOUND, which is not tidiness — it is the loudest symptom this
  // scenario has. A healthy pair exchanges a handful of state broadcasts (measured:
  // four). When the arbitration stops producing exactly one winner, the two devices
  // re-assert at each other as fast as the socket allows: breaking the
  // running-show rule in lib/live-arbitration.ts on purpose produced 391,150
  // relayed broadcasts in the same run. A fight like that can end with both screens
  // looking plausible, so the states alone would not always catch it.
  if (relayed > 200) {
    pairFailures.push(
      `${relayed} live-state broadcasts were relayed between two devices — a healthy ` +
        `pair sends a handful. The two are re-asserting control at each other, which ` +
        `is what a broken arbitration looks like from the outside.`
    );
  }
  if (decodeErrors.length > 0) {
    // The realtime wire format is not ours: realtime-js encodes a broadcast push as
    // packed binary. A bump that changes it shows up HERE first.
    pairFailures.push(
      `the stub could not decode ${decodeErrors.length} message(s): ${decodeErrors
        .map((m) => m.error)
        .join(" | ")}`
    );
  }

  // ── THE PAIR ITSELF ─────────────────────────────────────────────────────────
  // Written against WHO MUST END UP DRIVING (s.pair.controller) rather than against
  // "the PA", so the join scenario and the handoff scenario are the same five
  // checks. The interesting property is identical in both: after two devices have
  // finished negotiating, the room has one show on it.
  const aState = main?.liveReport?.after;
  const bState = peer?.liveReport?.after;
  if (!aState || !bState) {
    // Name WHICH one, and say what that means. A device that reported no live state
    // did not merely fail an assertion — it never got far enough to make one, and
    // its own verdict (printed above) carries the reason.
    const missing = [
      !aState && `the device that started the show (${s.pair.a.role})`,
      !bState && `the second device (${s.pair.b.role})`,
    ].filter(Boolean);
    pairFailures.push(
      `${missing.join(" and ")} reported no live state at all — see that device's own ` +
        `verdict above for why it never reached Live Mode`
    );
  } else {
    const driving = s.pair.controller === "a" ? aState : bState;
    const following = s.pair.controller === "a" ? bState : aState;
    const drivingName = s.pair.controller === "a" ? s.pair.a.role : s.pair.b.role;
    const followingName = s.pair.controller === "a" ? s.pair.b.role : s.pair.a.role;

    // 1. EXACTLY ONE CONTROLLER, and the RIGHT one. Two is the round-8 critical
    //    bug: a phone that had merely opened the page re-asserted its own empty
    //    INITIAL state over a PA that had reloaded mid-show, and the music stopped.
    if (!driving.controller || following.controller) {
      pairFailures.push(
        `controller went wrong: ${drivingName}=${driving.controller}, ` +
          `${followingName}=${following.controller} (exactly one device drives, and it must be ${drivingName})`
      );
    }
    // 2. THE SHOW SURVIVED. `begun` false anywhere means one of them reset it.
    if (!driving.begun || !following.begun) {
      pairFailures.push(
        `the show stopped being a running show somewhere: ${drivingName}.begun=${driving.begun}, ` +
          `${followingName}.begun=${following.begun}`
      );
    }
    // 3. BOTH SCREENS ON THE SAME ITEM. The fingerprint of the old bug was the
    //    joining device showing item 0 — which is why the show is advanced past it
    //    before the second device is ever launched.
    if (driving.index !== following.index) {
      pairFailures.push(
        `the two screens disagree about where the show is: ${drivingName} at item ` +
          `${driving.index}, ${followingName} at item ${following.index}`
      );
    }
    // 4. เครื่องเสียงคุมคนเดียว — one sound host, and it is whoever is driving.
    //    Audio and control travel together; two sound hosts is two PAs in one room.
    if (!driving.sound || following.sound) {
      pairFailures.push(
        `sound output went wrong: ${drivingName}=${driving.sound}, ` +
          `${followingName}=${following.sound} (only the driving device may sound)`
      );
    }
    // 5. AND THE SERVER AGREES. The DOM says what each device believes; the
    //    show_authority row is what the workspace would tell a THIRD device on
    //    join. One row, and it names the device that is actually driving.
    const claims = backend.tables.show_authority ?? [];
    if (claims.length !== 1 || claims[0].device_id !== driving.deviceId) {
      pairFailures.push(
        `show_authority holds ${claims.length} claim(s) (${
          claims.map((c) => c.device_id).join(", ") || "none"
        }), expected exactly one for ${drivingName} (${driving.deviceId})`
      );
    }
  }

  if (pairFailures.length === 0) return [main, peer];
  // Attach the failure to BOTH verdicts: this scenario has no meaningful half.
  const reason = pairFailures.join(" · ");
  return [
    { ...main, ok: false, failReason: main.failReason ?? reason },
    { ...peer, ok: false, failReason: peer.failReason ?? reason },
  ];
}

const results = [];
for (const s of chosen) {
  if (s.pair) {
    results.push(...(await runTwoDeviceScenario(s)));
    continue;
  }
  if (!s.backend) {
    results.push(await runScenario(s));
    continue;
  }
  // The stub Supabase, started only for the scenario that needs one and imported
  // lazily so `--only control` does not pay for it. Started and stopped OUT HERE
  // rather than inside runScenario: that function has half a dozen early returns for
  // the ways a launch can fail, and a listening socket left behind by one of them
  // would make the next run's port bind look like a flake.
  const { startSmokeBackend, SMOKE_WORLD } = await import("./smoke-backend.mjs");
  const backend = await startSmokeBackend();
  const host = new URL(SMOKE_SUPABASE_URL).host;
  console.log(`   stub Supabase at ${backend.url}, standing in for ${host}`);
  let result;
  try {
    result = await runScenario(s, {
      CUEIQ_SMOKE_BACKEND: backend.url,
      CUEIQ_SMOKE_BACKEND_FOR: host,
      CUEIQ_SMOKE_SIGN_IN: JSON.stringify({
        loginId: SMOKE_WORLD.auth.loginId,
        password: SMOKE_WORLD.auth.password,
      }),
    });
  } finally {
    await backend.close();
  }
  // ANTI-VACUITY. Everything else about this scenario is an assertion on the app;
  // this one is an assertion on the test. If the app never actually reached the
  // stub — a redirect that stopped matching, a session it refused, a build pointed
  // somewhere else — the caches it "wrote" could only have come from somewhere the
  // scenario does not control, and a pass would mean nothing.
  const tables = new Set(
    backend.requests
      .filter((r) => r.path.startsWith("/rest/v1/"))
      .map((r) => r.path.slice("/rest/v1/".length))
  );
  console.log(
    `   stub served ${backend.requests.length} request(s) across ${tables.size} table(s): ` +
      `${[...tables].join(", ") || "<none>"}`
  );
  // On a failure the request log is the whole diagnosis — "it cached nothing" and
  // "it asked for nothing" and "it asked and got a 401" are three different bugs
  // that look identical from the verdict alone.
  if (!result?.ok) {
    console.log("   what the stub actually saw:");
    for (const r of backend.requests.slice(0, 40)) {
      console.log(`      ${r.status} ${r.method} ${r.path}${r.search || ""}`);
    }
    if (backend.unimplementedPaths?.length) {
      console.log(`   NOT IMPLEMENTED by the stub: ${backend.unimplementedPaths.join(", ")}`);
    }
  }
  if (!tables.has("tenant_members") || !tables.has("events")) {
    result = {
      ...result,
      ok: false,
      failReason:
        `the app never read tenant_members and events from the stub (saw: ${[...tables].join(", ") || "nothing"}). ` +
        `Whatever it cached, it did not cache it from this test's backend.`,
    };
  }
  results.push(result);
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

// THE SECOND CROSS-CHECK: calibrate the network cut against a boot that had no cut.
// "The probe was rejected" is evidence of nothing on its own — it is only evidence if
// the SAME request to the SAME host resolves when nothing is blocking it. That was not
// a theoretical gap: main.cjs's probe used to aim at https://example.invalid, a
// reserved TLD guaranteed never to resolve, so it answered "rejected" on a machine
// with full internet and all three cut layers switched off. Everything downstream of
// it was decoration. The control scenario now runs the identical probe with the
// network up, and if THAT comes back rejected the airplane run's rejection is
// meaningless — this machine simply cannot reach the host either way.
if (control && control.netProbe) {
  const reachable = control.netProbe.main === "resolved" && control.netProbe.renderer === "resolved";
  if (!reachable) {
    failed = true;
    console.error(
      `::error::run-smoke: the control boot could not reach ${SMOKE_SUPABASE_URL} either ` +
        `(main=${control.netProbe.main}, renderer=${control.netProbe.renderer}), so "the network ` +
        `was cut" in the offline scenarios proves nothing — an unreachable probe host rejects ` +
        `whether or not the cut works. Either this machine has no internet, or that URL is stale.`
    );
  }
}

if (failed) process.exit(1);
console.log(`\nsmoke: all ${results.length} scenario(s) passed`);
