import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type * as TS from "typescript";

// Loaded through require, not `import ts from "typescript"`: vite would put the
// 9 MB compiler through its transform pipeline and print a source-map warning on
// every run. A test suite that prints a stack trace when it is HEALTHY teaches
// everyone to skim past the output.
const ts = createRequire(import.meta.url)("typescript") as typeof TS;

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
 * Replace every comment, string body and run of JSX text with spaces, preserving
 * length and every newline — so offsets (and therefore the reported line numbers)
 * still point at the real source. Without this a `.select(` mentioned in a prose
 * comment would satisfy the sweep, which is precisely the "comment-only fix" round
 * 10 kept finding.
 *
 * ⚠️ PARSED, NOT SCANNED BY HAND, and one of the guarded files is what forces it.
 * This used to be a character loop that treated every ' " and ` as a delimiter.
 * That is fine for mgmt-outbox.ts and catastrophic for setlist-builder.tsx, which
 * is JSX: a single apostrophe in prose text — `<p>don't leave both sets</p>` — opens
 * a "string" that swallows everything down to the next quote character, and any
 * `.delete()` in the swallowed region becomes INVISIBLE to the sweep. Silently: the
 * probe test below used to be an ASCII fixture with no JSX in it, so the detector
 * kept proving itself on input that could not expose the blindness. A scanner that
 * reports "clean" because it could not see is worse than no scanner.
 *
 * TypeScript's own parser is used instead — TSX for .tsx, TS for .ts, because a
 * `.ts` generic like `<T>(x: T) => x` is a syntax ERROR under the TSX grammar. Parse
 * diagnostics are fatal here rather than tolerated: an unparseable file is exactly
 * the case where a hand-rolled fallback would go quietly blind again.
 */
function blankNonCode(src: string, file: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (a: number, b: number) => {
    for (let k = Math.max(0, a); k < b && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };

  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  // `parseDiagnostics` is not on the public type, but it is the only way to learn
  // that createSourceFile produced a best-effort tree. Read defensively: if a future
  // TypeScript renames it, the sweep keeps working on parseable input rather than
  // throwing on every file.
  const diags = (sf as unknown as { parseDiagnostics?: readonly TS.Diagnostic[] })
    .parseDiagnostics;
  if (diags && diags.length > 0) {
    const d = diags[0];
    const where = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    throw new Error(
      `writeguard sweep: ${file} did not parse (${where.line + 1}:${where.character + 1} ` +
        `${ts.flattenDiagnosticMessageText(d.messageText, " ")}). The sweep refuses to ` +
        `scan a file it cannot tokenise — a "clean" result would be meaningless.`
    );
  }

  const seenComment = new Set<number>();
  const blankComments = (fullStart: number) => {
    for (const r of ts.getLeadingCommentRanges(src, fullStart) ?? []) {
      if (seenComment.has(r.pos)) continue;
      seenComment.add(r.pos);
      blank(r.pos, r.end);
    }
  };

  const visit = (node: TS.Node) => {
    blankComments(node.getFullStart());
    const start = node.getStart(sf);
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.RegularExpressionLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateTail:
        blank(start + 1, node.end - 1);
        return;
      // `\`text${` and `}text${` — two closing characters, not one.
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
        blank(start + 1, node.end - 2);
        return;
      // Prose between tags. Not code at all, so the whole span goes — this is the
      // apostrophe case that used to blind the scanner.
      case ts.SyntaxKind.JsxText:
        blank(start, node.end);
        return;
    }
    node.forEachChild(visit);
  };
  sf.forEachChild(visit);
  blankComments(sf.endOfFileToken.getFullStart());

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
  const code = blankNonCode(src, file);
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
      const code = blankNonCode(fs.readFileSync(path.join(ROOT, file), "utf8"), file);
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

  /** Writes `lines` to a temp file with the given extension and runs the sweep on it. */
  function onProbe<T>(ext: ".ts" | ".tsx", lines: string[], run: (probe: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cueiq-sweep-"));
    const probe = path.join(dir, `probe${ext}`);
    try {
      fs.writeFileSync(probe, lines.join("\n"), "utf8");
      return run(probe);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("still recognises a write that lost its .select()", () => {
    // The sweep is only worth having if it can fail. Prove the detector on a
    // synthetic chain rather than trusting an all-green run.
    const found = onProbe(
      ".ts",
      [
        "// .select( in a comment must not count",
        'const a = await supabase.from("events").delete().eq("id", id);',
        'const b = await supabase.from("events").update(p).eq("id", id).select("id");',
        "// write-guard-exempt: on purpose",
        'const c = await supabase.from("events").delete().eq("event_id", id);',
      ],
      findOffenders
    );
    expect(found.map((o) => ({ line: o.line, verb: o.verb }))).toEqual([
      { line: 2, verb: "delete" },
    ]);
  });

  it("sees through JSX PROSE — an apostrophe in a tag body is not a string", () => {
    // The blind spot that shipped: setlist-builder.tsx is one of the two guarded
    // files and it is full of JSX. Under the old character scanner the apostrophe in
    // "don't" opened a string that ran to the next quote — swallowing the `.from(`
    // and the `.delete()` on the line below — so the sweep reported the file clean
    // while looking at nothing. This fixture is the shape that did it, and it must
    // still name the unguarded delete.
    const found = onProbe(
      ".tsx",
      [
        "export function Panel() {",
        "  return (",
        "    <div>",
        "      <p>don't leave both sets</p>",
        "      <button",
        "        onClick={async () => {",
        '          await supabase.from("setlist_items").delete().eq("event_id", id);',
        "        }}",
        "      >",
        "        ล้าง",
        "      </button>",
        "    </div>",
        "  );",
        "}",
      ],
      findOffenders
    );
    expect(found.map((o) => ({ line: o.line, verb: o.verb }))).toEqual([
      { line: 7, verb: "delete" },
    ]);
  });

  it("refuses to scan a file it cannot parse instead of reporting it clean", () => {
    // A silently-degraded scanner is the whole defect class this file exists for, so
    // unparseable input has to be an error, not an empty offender list.
    expect(() =>
      onProbe(
        ".ts",
        ['const a = await supabase.from("events").delete(.eq("id", id);'],
        findOffenders
      )
    ).toThrow(/did not parse/);
  });
});
