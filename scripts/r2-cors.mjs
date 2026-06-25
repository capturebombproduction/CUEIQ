// ---------------------------------------------------------------------------
// Inspect / update the R2 bucket CORS policy.
//
//   node --env-file=.env.local scripts/r2-cors.mjs            # print current
//   node --env-file=.env.local scripts/r2-cors.mjs --add <origin> [<origin>...]
//
// The web app's audio path needs the browser to GET/PUT R2 objects directly via
// presigned URLs, so the bucket must CORS-allow each calling origin. The desktop
// SPA (different origin) needs its origin added too. --add MERGES origins into the
// existing rule set (dedup), never clobbering what's already allowed. Read-only by
// default. R2 creds come from .env.local (same vars lib/r2.ts uses).
// ---------------------------------------------------------------------------
import {
  S3Client,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } =
  process.env;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.error("Missing R2_* env vars (run with --env-file=.env.local)");
  process.exit(1);
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

async function getRules() {
  try {
    const res = await client.send(new GetBucketCorsCommand({ Bucket: R2_BUCKET }));
    return res.CORSRules ?? [];
  } catch (e) {
    if (e?.name === "NoSuchCORSConfiguration") return [];
    throw e;
  }
}

const args = process.argv.slice(2);
const rules = await getRules();
console.log("Current CORS rules:\n" + JSON.stringify(rules, null, 2));

const addIdx = args.indexOf("--add");
if (addIdx !== -1) {
  const origins = args.slice(addIdx + 1).filter((a) => !a.startsWith("--"));
  if (origins.length === 0) {
    console.error("--add needs at least one origin");
    process.exit(1);
  }
  // Merge into the FIRST rule (or create one) — keep its methods/headers, just
  // union in the new origins. This preserves the existing web-origin allowance.
  const next = rules.length ? rules.map((r) => ({ ...r })) : [
    {
      AllowedMethods: ["GET", "PUT", "HEAD"],
      AllowedHeaders: ["*"],
      AllowedOrigins: [],
      ExposeHeaders: ["ETag"],
      MaxAgeSeconds: 3600,
    },
  ];
  const target = next[0];
  const set = new Set(target.AllowedOrigins ?? []);
  for (const o of origins) set.add(o);
  target.AllowedOrigins = [...set];
  await client.send(
    new PutBucketCorsCommand({ Bucket: R2_BUCKET, CORSConfiguration: { CORSRules: next } })
  );
  console.log("\nUpdated CORS rules:\n" + JSON.stringify(await getRules(), null, 2));
}
