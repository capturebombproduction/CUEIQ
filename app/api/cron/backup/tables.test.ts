// ---------------------------------------------------------------------------
// THE BACKUP MUST NOT QUIETLY STOP COVERING A TABLE.
//
// The daily job dumps a fixed list, `TABLES`, and the comment above it says
// "Refresh the list when the schema grows" — which is an instruction to a human
// to remember something, months from now, while doing something else. It has held
// so far: verified on 2026-09-06 by pulling the newest snapshot out of R2 and
// counting every table against the live database. All 25 matched.
//
// But the failure mode is the worst shape there is. Add a table, forget this list,
// and NOTHING goes red: the job still succeeds, still writes a healthy-looking
// snapshot, still keeps thirty of them. The gap is discovered at the only moment
// it cannot be fixed — while restoring.
//
// So the list is checked against the migrations instead of against memory. Static
// on purpose: no database, no credentials, runs in CI on every push.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../../..");

/** Every table the migrations create, as the source of truth the backup must cover. */
function tablesInMigrations(): string[] {
  const dir = path.join(repoRoot, "supabase/migrations");
  const found = new Set<string>();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    for (const m of sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi
    )) {
      found.add(m[1].toLowerCase());
    }
  }
  return [...found].sort();
}

/** The list the job actually dumps, read as text — importing the route would pull
 *  in next/server, the AWS client and the service-role admin client. */
function tablesInBackupJob(): string[] {
  const src = fs.readFileSync(
    path.join(repoRoot, "app/api/cron/backup/route.ts"),
    "utf8"
  );
  const block = /const TABLES = \[([\s\S]*?)\] as const;/.exec(src);
  expect(block, "TABLES is no longer a plain array literal in the backup route").not.toBeNull();
  return [...block![1].matchAll(/"([a-z_][a-z0-9_]*)"/g)].map((m) => m[1]).sort();
}

describe("the daily backup covers the whole schema", () => {
  const declared = tablesInBackupJob();
  const created = tablesInMigrations();

  it("finds both lists", () => {
    expect(created.length).toBeGreaterThan(20);
    expect(declared.length).toBeGreaterThan(20);
  });

  // THE ONE THAT MATTERS. A table the job does not name is a table nobody gets back.
  it("dumps every table the migrations create", () => {
    const missing = created.filter((t) => !declared.includes(t));
    expect(
      missing,
      `app/api/cron/backup/route.ts does not back these up: ${missing.join(", ")}. ` +
        `Nothing will go red about this — the job succeeds and writes a healthy-looking ` +
        `snapshot — so it would only be found while restoring. Add them to TABLES.`
    ).toEqual([]);
  });

  // The other direction is a smaller problem but still a real one: a name that no
  // longer exists makes every run report a per-table error, and a job that always
  // errors is a job whose errors stop being read.
  it("does not name a table the migrations never create", () => {
    const extra = declared.filter((t) => !created.includes(t));
    expect(
      extra,
      `TABLES names ${extra.join(", ")}, which no migration creates. Every run would ` +
        `report a per-table error for it, and an alarm that is always on is not an alarm.`
    ).toEqual([]);
  });
});
