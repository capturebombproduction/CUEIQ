import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// A STRUCTURAL sweep, not a behavioural one.
//
// "A write that reported no error but touched no row did not happen"
// (lib/write-guard.ts) is only checkable when the write asks for its rows back:
// `.update(p).eq("id", id).select("id")`. Round 10's most common defect was a fix
// that could not execute — a guard whose write never selected, so the guard's
// input was always undefined and the branch was dead. Two such holes shipped in
// the files below: the setlist RESTORE deleted the old rows with no .select() and
// walked on to insert the snapshot (leaving the original setlist PLUS a full
// duplicate, which is what the run sheet then printed), and the desktop outbox
// recorded an RLS-filtered event delete as SYNCED and threw the queued intent
// away.
//
// A behavioural test proves today's call sites. This proves the NEXT one: a new
// `.delete(`/`.update(` added to either file without a `.select(` fails here, at
// the line, before it can ship. Where 0 rows is genuinely the normal outcome (a
// replace-set delete that removed nothing), the source says so with a
// `write-guard-exempt:` comment — which is a decision on the record, not a hole.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const GUARDED_FILES = [
  "components/event/setlist-builder.tsx",
  "desktop/src/data/mgmt-outbox.ts",
];

/** Opt-out marker: put it in a comment within 8 lines above the write. */
const EXEMPT = "write-guard-exempt";

/**
 * Replace every comment and string body with spaces, preserving length and every
 * newline — so offsets (and therefore the reported line numbers) still point at
 * the real source. Without this a `.select(` mentioned in a prose comment would
 * satisfy the sweep, which is precisely the "comment-only fix" round 10 kept
 * finding.
 */
function blankNonCode(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const j = src.indexOf("\n", i);
      const end = j === -1 ? n : j;
      blank(i, end);
      i = end;
    } else if (two === "/*") {
      const j = src.indexOf("*/", i + 2);
      const end = j === -1 ? n : j + 2;
      blank(i, end);
      i = end;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const quote = src[i];
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        j++;
      }
      blank(i + 1, j);
      i = Math.min(j + 1, n);
    } else i++;
  }
  return out.join("");
}

interface Offender {
  file: string;
  line: number;
  verb: string;
  statement: string;
}

/**
 * Statements are split on `;`. That can only ever OVER-split (an arrow body, a
 * `;` inside a type annotation) — never merge two statements — and a postgrest
 * chain contains no `;`, so a write and its `.select()` always land in the same
 * chunk. Within a chunk the window for one write ends at the next `.from(`, so
 * `Promise.all([ …update().select(), …update().select() ])` is judged per write
 * rather than by a single `.select()` covering both.
 */
function findOffenders(file: string): Offender[] {
  const src = fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), "utf8");
  const code = blankNonCode(src);
  const lines = src.split("\n");
  const lineAt = (offset: number) => code.slice(0, offset).split("\n").length;
  const offenders: Offender[] = [];

  let chunkStart = 0;
  for (let end = 0; end <= code.length; end++) {
    if (end !== code.length && code[end] !== ";") continue;
    const chunk = code.slice(chunkStart, end);
    const base = chunkStart;
    chunkStart = end + 1;
    if (!chunk.includes(".from(")) continue;
    const writes = /\.(delete|update)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = writes.exec(chunk)) !== null) {
      const after = chunk.slice(m.index);
      const nextChain = after.indexOf(".from(", 1);
      const window = nextChain === -1 ? after : after.slice(0, nextChain);
      if (window.includes(".select(")) continue;
      const line = lineAt(base + m.index);
      // The marker lives in a comment, which blankNonCode wiped — look it up in
      // the ORIGINAL source, in the few lines directly above the write.
      const exempt = lines
        .slice(Math.max(0, line - 9), line)
        .some((l) => l.includes(EXEMPT));
      if (exempt) continue;
      offenders.push({
        file,
        line,
        verb: m[1],
        statement: (lines[line - 1] ?? "").trim(),
      });
    }
  }
  return offenders;
}

describe("every supabase write in the write-guard files asks for its rows back", () => {
  it("parses the guarded files without swallowing their chains", () => {
    // Guards the sweep itself: a scanner that silently matched nothing would
    // report a clean sweep for ever. Both files must still contain writes.
    for (const file of GUARDED_FILES) {
      const code = blankNonCode(fs.readFileSync(path.join(ROOT, file), "utf8"));
      expect(/\.(delete|update)\s*\(/.test(code), `${file} has no writes at all`).toBe(true);
      expect(code.includes(".select("), `${file} has no .select( at all`).toBe(true);
    }
  });

  it.each(GUARDED_FILES)("%s", (file) => {
    const offenders = findOffenders(file);
    const message = offenders
      .map(
        (o) =>
          `${o.file}:${o.line}  .${o.verb}() with no .select() — ` +
          `a 0-row result is indistinguishable from success here.\n` +
          `      ${o.statement}\n` +
          `      Fix: chain .select("id") and check wroteNothing(data) (lib/write-guard.ts), ` +
          `or put a "${EXEMPT}: <why>" comment above it.`
      )
      .join("\n");
    expect(message).toBe("");
  });

  it("still recognises a write that lost its .select()", () => {
    // The sweep is only worth having if it can fail. Prove the detector on a
    // synthetic chain rather than trusting an all-green run.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cueiq-sweep-"));
    const probe = path.join(dir, "probe.ts");
    try {
      fs.writeFileSync(
        probe,
        [
          "// .select( in a comment must not count",
          'const a = await supabase.from("events").delete().eq("id", id);',
          'const b = await supabase.from("events").update(p).eq("id", id).select("id");',
          "// write-guard-exempt: on purpose",
          'const c = await supabase.from("events").delete().eq("event_id", id);',
        ].join("\n"),
        "utf8"
      );
      const found = findOffenders(probe);
      expect(found.map((o) => ({ line: o.line, verb: o.verb }))).toEqual([
        { line: 2, verb: "delete" },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
