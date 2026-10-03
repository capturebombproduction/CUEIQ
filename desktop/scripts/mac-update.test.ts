// desktop/electron/mac-update.cjs + desktop/build/rename-mac-arch.cjs — the Mac replacing
// itself (พี่, 2026-10-03: "กดอัพเดทเหมือนอัพเดทเกมส์"). What can go wrong here is not a wrong
// screen, it is a show laptop whose app is half-replaced, so every case asserts on the DISK:
// which bytes were kept, which bundle sits where afterwards, what the result file says.
//
// Lives in the node "scripts" project (vitest.config.ts) because it runs real child
// processes and a real /bin/sh. The swap script itself is exercised here with stand-ins for
// the two macOS-only tools it calls (ditto → cp -R, open → a log line), so the Linux CI job
// runs its every branch; desktop/scripts/mac-update-smoke.mjs then runs it for real on the
// CI Mac, with the real ditto/hdiutil/codesign, against the .dmg about to be published.
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type FeedFile = { url: string; sha512: string; size: number };
type Exec = (cmd: string, args: string[]) => Promise<string>;
const require = createRequire(import.meta.url);
const mac = require("../electron/mac-update.cjs") as {
  download: (o: {
    url: string;
    dest: string;
    sha512: string;
    size: number;
    fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
    onProgress?: (p: number) => void;
    stallMs?: number;
  }) => Promise<string>;
  bundleVersion: (app: string) => string | null;
  stageFromDmg: (o: { dmg: string; workDir: string; expectVersion: string; exec?: Exec }) => Promise<string>;
  INSTALL_SCRIPT: string;
  spawnInstaller: (o: {
    workDir: string;
    pid: number;
    app: string;
    staged: string;
    resultFile: string;
    reopen: boolean;
    version: string;
  }) => unknown;
};
const feed = require("../electron/update-feed.cjs") as {
  parseFeedYml: (t: string) => { version: string; files: FeedFile[] } | null;
  macAssetFor: (f: { version: string; files: FeedFile[] } | null, arch: string) => FeedFile | null;
};
const renameHook = require("../build/rename-mac-arch.cjs") as {
  default: (ctx: { artifactPaths: string[] }) => Promise<string[]>;
};
const VERSION = (JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")) as { version: string })
  .version;

const sha512 = (b: Uint8Array) => crypto.createHash("sha512").update(b).digest("base64");
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cueiq-macupd-"));
});
afterEach(() => {
  try {
    fs.chmodSync(dir, 0o755);
  } catch {
    /* already writable */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fetch whose body is `chunks`; `hang` keeps the stream open until the signal aborts it. */
function fakeFetch(chunks: Uint8Array[], { status = 200, hang = false } = {}) {
  return async (_url: string, init?: { signal?: AbortSignal }) => {
    if (status !== 200) return new Response(null, { status });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
        if (!hang) c.close();
        init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
      },
    });
    return new Response(body);
  };
}

describe("download(): only the bytes the feed describes are kept", () => {
  const data = crypto.randomBytes(300_000);
  const chunks = [data.subarray(0, 100_000), data.subarray(100_000, 200_000), data.subarray(200_000)];

  it("keeps a download whose size and sha512 match, and reports progress up to 100", async () => {
    const dest = path.join(dir, "x", "CueIQ.dmg");
    const seen: number[] = [];
    const got = await mac.download({
      url: "https://example.test/x.dmg",
      dest,
      sha512: sha512(data),
      size: data.length,
      fetch: fakeFetch(chunks),
      onProgress: (p) => seen.push(p),
    });
    expect(got).toBe(dest);
    expect(Buffer.compare(fs.readFileSync(dest), data)).toBe(0);
    expect(fs.existsSync(dest + ".part")).toBe(false);
    expect(seen[seen.length - 1]).toBe(100);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it("a wrong hash leaves NOTHING on disk (no file, no .part)", async () => {
    const dest = path.join(dir, "CueIQ.dmg");
    await expect(
      mac.download({ url: "u", dest, sha512: sha512(Buffer.from("other")), size: data.length, fetch: fakeFetch(chunks) })
    ).rejects.toThrow(/sha512/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses a short download and stops a long one at the listed size", async () => {
    const dest = path.join(dir, "CueIQ.dmg");
    await expect(
      mac.download({ url: "u", dest, sha512: sha512(data), size: data.length + 1, fetch: fakeFetch(chunks) })
    ).rejects.toThrow(/feed lists/);
    await expect(
      mac.download({ url: "u", dest, sha512: sha512(data), size: data.length - 1, fetch: fakeFetch(chunks) })
    ).rejects.toThrow(/larger than/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("an HTTP error and a stalled connection both reject (and leave nothing)", async () => {
    const dest = path.join(dir, "CueIQ.dmg");
    await expect(
      mac.download({ url: "u", dest, sha512: "x", size: 1, fetch: fakeFetch([], { status: 404 }) })
    ).rejects.toThrow(/404/);
    await expect(
      mac.download({
        url: "u",
        dest,
        sha512: sha512(data),
        size: data.length,
        fetch: fakeFetch([chunks[0]], { hang: true }),
        stallMs: 80,
      })
    ).rejects.toThrow(/stalled/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

/** A minimal .app: Info.plist with a version, plus a marker file to tell copies apart. */
function writeBundle(app: string, version: string, marker = version) {
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0"?>\n<plist><dict>\n<key>CFBundleShortVersionString</key>\n<string>${version}</string>\n</dict></plist>\n`
  );
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "marker"), marker);
}
const marker = (app: string) => fs.readFileSync(path.join(app, "Contents", "MacOS", "marker"), "utf8");

describe("stageFromDmg(): mount, copy out, unmount, check", () => {
  function tools({ version = "0.1.26", failCopy = false, failSign = false } = {}) {
    const calls: string[] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push(`${cmd} ${args[0]}`);
      if (cmd === "hdiutil" && args[0] === "attach") {
        writeBundle(path.join(args[args.indexOf("-mountpoint") + 1], "CueIQ.app"), version);
      }
      if (cmd === "ditto") {
        if (failCopy) throw new Error("ditto: No space left on device");
        fs.cpSync(args[0], args[1], { recursive: true });
      }
      if (cmd === "codesign" && failSign) throw new Error("codesign: a sealed resource is missing or invalid");
      return "";
    };
    return { exec, calls };
  }

  it("returns a staged copy that says the right version, verified after the unmount", async () => {
    const t = tools();
    const staged = await mac.stageFromDmg({ dmg: "/x.dmg", workDir: dir, expectVersion: "0.1.26", exec: t.exec });
    expect(staged).toBe(path.join(dir, "stage", "CueIQ.app"));
    expect(mac.bundleVersion(staged)).toBe("0.1.26");
    expect(t.calls).toEqual(["hdiutil attach", `ditto ${path.join(dir, "mnt", "CueIQ.app")}`, "hdiutil detach", "codesign --verify"]);
  });

  it("unmounts even when the copy fails", async () => {
    const t = tools({ failCopy: true });
    await expect(
      mac.stageFromDmg({ dmg: "/x.dmg", workDir: dir, expectVersion: "0.1.26", exec: t.exec })
    ).rejects.toThrow(/No space/);
    expect(t.calls).toContain("hdiutil detach");
  });

  it("refuses a .dmg holding another version, or a bundle whose signature does not verify", async () => {
    await expect(
      mac.stageFromDmg({ dmg: "/x.dmg", workDir: dir, expectVersion: "0.1.26", exec: tools({ version: "0.1.25" }).exec })
    ).rejects.toThrow(/0\.1\.25/);
    await expect(
      mac.stageFromDmg({ dmg: "/x.dmg", workDir: dir, expectVersion: "0.1.26", exec: tools({ failSign: true }).exec })
    ).rejects.toThrow(/codesign/);
  });
});

// The swap. Real /bin/sh; ditto and open replaced by stand-ins on PATH (macOS-only tools).
describe.skipIf(process.platform === "win32")("the swap script", () => {
  let env: NodeJS.ProcessEnv;
  let script: string;
  let app: string;
  let staged: string;
  let result: string;
  let openLog: string;
  let signLog: string;
  beforeEach(() => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "ditto"), '#!/bin/sh\nexec cp -R "$1" "$2"\n', { mode: 0o755 });
    openLog = path.join(dir, "opened.log");
    fs.writeFileSync(path.join(bin, "open"), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${openLog}'\n`, { mode: 0o755 });
    // codesign stand-in: verifies unless the bundle carries a BROKEN file
    signLog = path.join(dir, "signed.log");
    fs.writeFileSync(
      path.join(bin, "codesign"),
      `#!/bin/sh\nfor a; do last="$a"; done\nprintf '%s\\n' "$last" >> '${signLog}'\n[ ! -e "$last/Contents/BROKEN" ]\n`,
      { mode: 0o755 }
    );
    env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    script = path.join(dir, "install.sh");
    fs.writeFileSync(script, mac.INSTALL_SCRIPT, { mode: 0o755 });
    fs.mkdirSync(path.join(dir, "Applications"));
    app = path.join(dir, "Applications", "CueIQ.app");
    writeBundle(app, "0.1.25", "old");
    staged = path.join(dir, "work", "stage", "CueIQ.app");
    writeBundle(staged, "0.1.26", "new");
    result = path.join(dir, "result.txt");
  });
  const deadPid = () => spawnSync("true").pid as number;
  const run = (pid: number, { appPath = app, reopen = "1", version = "0.1.26" } = {}) =>
    new Promise<number>((resolve) => {
      const p = spawn("/bin/sh", [script, String(pid), appPath, staged, result, reopen, version], {
        env,
        stdio: "ignore",
      });
      p.on("exit", (code) => resolve(code ?? -1));
    });
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : null);
  const apps = () => fs.readdirSync(path.join(dir, "Applications")).sort();
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("puts the new bundle in place — checked first — leaves no debris, and reopens it", async () => {
    expect(await run(deadPid())).toBe(0);
    expect(read(result)).toBe("ok");
    expect(marker(app)).toBe("new");
    expect(apps()).toEqual(["CueIQ.app"]);
    expect(fs.existsSync(staged)).toBe(false);
    expect(read(openLog)).toBe(app);
    expect(read(signLog)).toBe(`${app}.updating`); // the copy was verified before the swap
  });

  it("a plain quit swaps without reopening", async () => {
    expect(await run(deadPid(), { reopen: "0" })).toBe(0);
    expect(marker(app)).toBe("new");
    expect(read(openLog)).toBeNull();
  });

  it("copies beside the old app while it quits, but swaps only once it has exited", async () => {
    const old = spawn("sleep", ["1.5"]);
    const exited = new Promise<void>((r) => old.on("exit", () => r()));
    const swap = run(old.pid as number);
    await wait(700);
    expect(marker(app)).toBe("old"); // still waiting…
    expect(marker(`${app}.updating`)).toBe("new"); // …with the slow copy already done
    await exited;
    expect(await swap).toBe(0);
    expect(marker(app)).toBe("new");
    expect(apps()).toEqual(["CueIQ.app"]);
  });

  it("calls the swap off if the old app was reopened meanwhile (no reopen, staged copy kept)", async () => {
    // a process running FROM the installed bundle, as a Dock relaunch does: a copy of sleep
    // as Contents/MacOS/CueIQ (not `sh -c … <path>`: macOS sh execs the command and the
    // path vanishes from the command line — the CI Mac caught exactly that)
    const exe = path.join(app, "Contents", "MacOS", "CueIQ");
    fs.copyFileSync(spawnSync("/bin/sh", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim(), exe);
    fs.chmodSync(exe, 0o755);
    const relaunched = spawn(exe, ["5"]);
    try {
      expect(await run(deadPid())).toBe(1);
    } finally {
      relaunched.kill();
    }
    expect(read(result)).toBe("fail:relaunched");
    expect(marker(app)).toBe("old");
    expect(apps()).toEqual(["CueIQ.app"]);
    expect(fs.existsSync(staged)).toBe(true); // main.cjs offers "ติดตั้ง" again from it
    expect(read(openLog)).toBeNull();
  });

  it("a copy that does not verify (wrong version, broken signature) never replaces the app", async () => {
    expect(await run(deadPid(), { version: "0.1.99" })).toBe(1);
    expect(read(result)).toBe("fail:verify");
    expect(marker(app)).toBe("old");
    expect(apps()).toEqual(["CueIQ.app"]);
    fs.writeFileSync(path.join(staged, "Contents", "BROKEN"), "");
    expect(await run(deadPid())).toBe(1);
    expect(read(result)).toBe("fail:verify");
    expect(marker(app)).toBe("old");
    expect(apps()).toEqual(["CueIQ.app"]);
  });

  it("a failure found before the exit is reported (and reopened) only AFTER the exit", async () => {
    const old = spawn("sleep", ["1"]);
    let goneAt = 0;
    old.on("exit", () => (goneAt = Date.now()));
    expect(await run(old.pid as number, { version: "0.1.99" })).toBe(1);
    const reportedAt = fs.statSync(result).mtimeMs;
    expect(goneAt).toBeGreaterThan(0);
    expect(reportedAt).toBeGreaterThanOrEqual(goneAt - 50);
    expect(read(openLog)).toBe(app);
  });

  it.skipIf(process.getuid?.() === 0)("a folder it may not write: the OLD app stays whole and reopens", async () => {
    fs.chmodSync(path.join(dir, "Applications"), 0o555);
    expect(await run(deadPid())).toBe(1);
    fs.chmodSync(path.join(dir, "Applications"), 0o755);
    expect(read(result)).toMatch(/^fail:/);
    expect(marker(app)).toBe("old");
    expect(apps()).toEqual(["CueIQ.app"]);
    expect(read(openLog)).toBe(app);
  });

  it("refuses a path that is not an .app before it deletes anything", async () => {
    const notApp = path.join(dir, "Applications");
    expect(await run(deadPid(), { appPath: notApp })).toBe(1);
    expect(read(result)).toBe("fail:bad-path");
    expect(marker(app)).toBe("old");
    expect(fs.existsSync(staged)).toBe(true);
  });

  it("spawnInstaller (what main.cjs calls on quit) runs the same swap, detached", async () => {
    // the detached child inherits THIS process's PATH — point it at the stand-ins
    const savedPath = process.env.PATH;
    process.env.PATH = env.PATH;
    try {
      mac.spawnInstaller({
        workDir: path.join(dir, "work"),
        pid: deadPid(),
        app,
        staged,
        resultFile: result,
        reopen: false,
        version: "0.1.26",
      });
    } finally {
      process.env.PATH = savedPath;
    }
    for (let i = 0; i < 100 && read(result) === null; i++) await wait(50);
    expect(read(result)).toBe("ok");
    expect(marker(app)).toBe("new");
  });
});

describe("the build's feed (rename-mac-arch.cjs) is what the app will check against", () => {
  it("renames the .dmg files and writes latest-mac.yml with each one's real sha512 and size", async () => {
    const arm = path.join(dir, `CueIQ-${VERSION}-Mac-arm64.dmg`);
    const intel = path.join(dir, `CueIQ-${VERSION}-Mac-x64.dmg`);
    const exe = path.join(dir, `CueIQ-${VERSION}-Windows.exe`);
    const armBytes = crypto.randomBytes(5000);
    const intelBytes = crypto.randomBytes(7000);
    fs.writeFileSync(arm, armBytes);
    fs.writeFileSync(intel, intelBytes);
    fs.writeFileSync(exe, "exe");
    const out = await renameHook.default({ artifactPaths: [arm, intel, exe] });
    const yml = path.join(dir, "latest-mac.yml");
    expect(out).toEqual([
      path.join(dir, `CueIQ-${VERSION}-Mac-Apple-Silicon.dmg`),
      path.join(dir, `CueIQ-${VERSION}-Mac-Intel.dmg`),
      exe,
      yml,
    ]);
    const parsed = feed.parseFeedYml(fs.readFileSync(yml, "utf8"));
    expect(parsed?.version).toBe(VERSION);
    expect(feed.macAssetFor(parsed, "arm64")).toEqual({
      url: `CueIQ-${VERSION}-Mac-Apple-Silicon.dmg`,
      sha512: sha512(armBytes),
      size: 5000,
    });
    expect(feed.macAssetFor(parsed, "x64")).toEqual({
      url: `CueIQ-${VERSION}-Mac-Intel.dmg`,
      sha512: sha512(intelBytes),
      size: 7000,
    });
  });

  it("a Windows-only build writes no Mac feed", async () => {
    const exe = path.join(dir, `CueIQ-${VERSION}-Windows.exe`);
    fs.writeFileSync(exe, "exe");
    expect(await renameHook.default({ artifactPaths: [exe] })).toEqual([exe]);
    expect(fs.existsSync(path.join(dir, "latest-mac.yml"))).toBe(false);
  });
});
