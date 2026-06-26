// Pull the latest off-machine DB snapshot back from R2 and verify it's intact —
// the other half of app/api/cron/backup. READ-ONLY: it never writes to Supabase,
// only downloads the newest backups/ object, parses it (a bad/corrupt file throws
// here), prints per-table row counts, and saves a local copy.
//
// Usage: node --env-file=.env.local scripts/restore.mjs [--out <file>]
//
// To actually RESTORE into a database (break-glass DR), insert snap.data[table]
// arrays parent->child to satisfy FKs. Do that against a FRESH/empty project, never
// blindly against live prod (bands are using it).
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { writeFileSync, mkdirSync } from "node:fs";

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.error("missing R2_* env vars (need .env.local)");
  process.exit(1);
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

// Find the newest object under backups/.
let token;
let newest = null;
do {
  const res = await client.send(
    new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: "backups/", ContinuationToken: token })
  );
  for (const o of res.Contents ?? []) {
    if (!newest || o.LastModified > newest.LastModified) newest = o;
  }
  token = res.IsTruncated ? res.NextContinuationToken : undefined;
} while (token);

if (!newest) {
  console.error("no backups found under backups/ — has the cron run yet?");
  process.exit(1);
}
console.log(
  `latest: ${newest.Key} (${(newest.Size / 1024).toFixed(1)} KB · ${newest.LastModified.toISOString()})`
);

const obj = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: newest.Key }));
const text = await obj.Body.transformToString();
const snap = JSON.parse(text); // corrupt file → throws = verification failed

const counts = snap.counts ?? {};
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`generatedAt: ${snap.generatedAt} · commit: ${snap.commit ?? "?"}`);
console.log(`tables: ${Object.keys(snap.data ?? {}).length} · rows: ${total}`);
for (const [t, n] of Object.entries(counts).sort()) console.log(`  ${t}: ${n}`);
if (snap.errors && Object.keys(snap.errors).length) {
  console.log("dump errors:", snap.errors);
}

const outArg = process.argv.indexOf("--out");
const out = outArg > -1 ? process.argv[outArg + 1] : `backups/restored-${newest.Key.split("/").pop()}`;
mkdirSync("backups", { recursive: true });
writeFileSync(out, text);
console.log(`saved local copy -> ${out}`);
console.log("\nOK — backup is retrievable + parses cleanly.");
