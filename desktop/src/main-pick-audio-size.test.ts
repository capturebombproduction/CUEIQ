import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// 2026-10-27 hunt 7 - the native audio picker (main.cjs pickAudioFile).
//
// It read whatever was picked with a synchronous readFileSync, and the dialog offers
// "All Files": a big file, or any file on a slow USB stick or network share, froze the main
// process for the whole read; past 2 GB it threw; and a file of a gigabyte or so was then
// cloned over IPC into the renderer that may be running the show. Pinned against the REAL
// function body run in a sandbox (main.cjs boots Electron and cannot be imported).

const main = fs.readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");

function buildPicker(size: number) {
  const at = main.indexOf("async function pickAudioFile() {");
  expect(at).toBeGreaterThan(-1);
  const end = main.slice(at).search(/\r?\n\}\r?\n/);
  expect(end).toBeGreaterThan(-1);
  // the function, plus the cap it reads (absent = no cap at all)
  const cap =
    /const PICK_AUDIO_MAX_BYTES = [^;]+;/.exec(main)?.[0] ?? "const PICK_AUDIO_MAX_BYTES = Infinity;";
  const body = main.slice(at, at + end) + "\n}\n" + cap;
  const calls = { sync: 0, async: 0 };
  const fakeFs = {
    readFileSync: () => {
      calls.sync++;
      return Buffer.alloc(4);
    },
    promises: {
      stat: async () => ({ size }),
      readFile: async () => {
        calls.async++;
        return Buffer.alloc(4);
      },
    },
  };
  const dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: ["/songs/take.wav"] }) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const pick = new Function(
    "fs",
    "path",
    "dialog",
    `async function readLastAudioDir() { return undefined; }
     function writeLastAudioDir() {}
     ${body}
     return pickAudioFile;`
  )(fakeFs, path, dialog) as () => Promise<{ name: string; bytes: Uint8Array } | null>;
  return { pick, calls };
}

describe("main.cjs pickAudioFile", () => {
  it("refuses a file over the cap, in Thai, before reading a byte of it", async () => {
    const { pick, calls } = buildPicker(1200 * 1024 * 1024);
    await expect(pick()).rejects.toThrow(/ไฟล์ใหญ่เกินไป/);
    expect(calls.sync + calls.async).toBe(0);
  });

  it("reads a master-sized file without blocking the main process", async () => {
    const { pick, calls } = buildPicker(88 * 1024 * 1024);
    const got = await pick();
    expect(got?.name).toBe("take.wav");
    expect(calls).toEqual({ sync: 0, async: 1 });
  });
});
