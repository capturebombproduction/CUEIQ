// Full-database JSON snapshot via the Supabase Management API.
// Usage: node --env-file=.env.local scripts/backup.mjs
// Writes backups/cueiq-snapshot-<timestamp>.json (every public table, all rows).
//
// This is a peace-of-mind data export. The DB lives in Supabase Postgres,
// fully separate from Vercel/app code — deploys never touch it — but a snapshot
// guards against accidental deletes / "oops" mutations. Restore = re-insert the
// arrays per table (parents before children for FKs).
//
// ⚠️ The output contains EVERY row (incl. profiles, push subs, etc.) — sensitive.
// backups/ is gitignored; copy the file somewhere safe (cloud/external drive).

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token || !url) {
  console.error("need SUPABASE_ACCESS_TOKEN and NEXT_PUBLIC_SUPABASE_URL (use --env-file=.env.local)");
  process.exit(1);
}
const ref = new URL(url).hostname.split(".")[0];

async function runSql(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}\n${text}`);
  return JSON.parse(text);
}

const started = Date.now();

// 1) authoritative live table list (no hard-coding — picks up new tables too)
const tableRows = await runSql(
  "select table_name from information_schema.tables " +
    "where table_schema='public' and table_type='BASE TABLE' order by table_name"
);
const tables = tableRows.map((r) => r.table_name);
console.log(`📋 ${tables.length} tables to snapshot…`);

// 2) dump every table's rows as JSON
const data = {};
const counts = {};
for (const t of tables) {
  const rows = await runSql(
    `select coalesce(json_agg(x), '[]'::json) as data from public."${t}" x`
  );
  const arr = rows[0]?.data ?? [];
  data[t] = arr;
  counts[t] = arr.length;
  console.log(`  • ${t.padEnd(22)} ${arr.length} rows`);
}

// 3) assemble snapshot
const snapshot = {
  generated_at: new Date().toISOString(),
  project_ref: ref,
  table_count: tables.length,
  row_counts: counts,
  total_rows: Object.values(counts).reduce((a, b) => a + b, 0),
  tables: data,
};

// 4) write timestamped file
const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "backups");
await mkdir(outDir, { recursive: true });
const fname = `cueiq-snapshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
const outPath = join(outDir, fname);
const json = JSON.stringify(snapshot, null, 2);
await writeFile(outPath, json, "utf8");

const kb = (Buffer.byteLength(json, "utf8") / 1024).toFixed(1);
console.log(
  `\n✅ Snapshot: ${snapshot.total_rows} rows across ${tables.length} tables` +
    `\n   → backups/${fname}  (${kb} KB, ${((Date.now() - started) / 1000).toFixed(1)}s)` +
    `\n   ⚠️ contains sensitive data — copy somewhere safe; backups/ is gitignored.`
);
