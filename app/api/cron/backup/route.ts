import { NextResponse } from "next/server";
import {
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { r2Client, r2Configured, R2_BUCKET } from "@/lib/r2";
import { cronSecretMatches, reportCronFailure } from "@/lib/cron-report";

// Daily snapshots are tiny (~few hundred rows of JSON) but unbounded growth is
// still untidy — keep only the most recent RETAIN. 30 daily = ~a month of history.
const RETAIN = 30;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Daily off-machine snapshot (Vercel Cron → see vercel.json). Dumps every public
// table via the service-role client and writes ONE JSON to R2 under backups/ — so
// the live label data survives this machine dying, without any external service
// (R2 is already wired for audio). Mirrors scripts/backup.mjs but runs in prod and
// lands OFF this box. The R2 backups/ prefix is never presigned/served, so it isn't
// publicly reachable. Gate is the same CRON_SECRET Bearer the reminders job uses.
//
// ⚠️ KNOWN LIMITATION: this snapshot is written into R2_BUCKET — the SAME bucket
// that holds the audio masters it's meant to be a fallback for. It is under its
// own key prefix (backups/, never mixed with song audio) and keeps RETAIN dated
// snapshots rather than overwriting one, so it isn't a single point of failure
// against ordinary mistakes (an accidental delete of one object, a bad prune).
// But it does NOT survive losing the bucket itself, the R2 account, or the R2
// credentials — a real off-machine backup needs a genuinely separate destination
// (a second bucket in a different account, or a different provider entirely).
// That requires provisioning something outside this codebase, so it hasn't been
// done; whoever picks this up next should not assume "runs in prod, lands off
// the app server" also means "survives losing R2".
//
// Failures are also no longer silent: a config gap, an upload failure, or a
// per-table read error all write a row to client_errors (kind: "cron") via
// reportCronFailure — the same table the in-app error reporter uses, surfaced
// in the admin Dev Inbox — and a run with ANY per-table error returns a
// non-200 status so platform-level monitoring sees it too. The unauthorized
// (401) branch is deliberately NOT reported this way — see reportCronFailure's
// doc comment for why.
//
// TABLES = every public base table. Refresh the list when the schema grows:
//   select string_agg(table_name, ',' order by table_name) from
//   information_schema.tables where table_schema='public' and table_type='BASE TABLE';
const TABLES = [
  "client_errors", "event_members", "events", "feedback", "group_roles", "groups",
  "members", "mic_assignments", "notifications", "practice_attendance", "practice_logs",
  "practice_runs", "practice_songs", "profiles", "push_subscriptions", "run_sequence",
  "schedule_items", "setlist_items", "setlist_versions", "show_authority", "song_markers",
  "songs", "staff_contacts", "tenant_members", "tenants",
] as const;

// PostgREST caps a plain select at max-rows (1000 on Supabase) and truncates
// SILENTLY — once a table passes that, the snapshot would still report ok:true with
// a healthy-looking count while the rest of the rows are simply missing. So read
// every table in pages instead. PAGE_SIZE matches the cap (one round-trip per 1000
// rows); MAX_PAGES only exists so a misbehaving server can never spin forever — it
// throws, i.e. a truncated table is reported as an error, never written silently.
const PAGE_SIZE = 1000;
const MAX_PAGES = 200;

// Stable sort key so OFFSET paging can't skip or repeat rows. Every table has a
// uuid `id` except show_authority, whose PK is (event_id, kind).
const ORDER_BY: Partial<Record<(typeof TABLES)[number], string[]>> = {
  show_authority: ["event_id", "kind"],
};

/**
 * Read a whole table, page by page. Ends ONLY on an empty page (not merely a short
 * one) so a server-side row cap smaller than PAGE_SIZE still pages on instead of
 * stopping early, and throws rather than returning a partial table — the caller
 * turns that into a real per-table error in the snapshot.
 */
async function selectAll(
  admin: ReturnType<typeof createAdminClient>,
  table: (typeof TABLES)[number]
): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = admin.from(table).select("*").range(rows.length, rows.length + PAGE_SIZE - 1);
    for (const col of ORDER_BY[table] ?? ["id"]) q = q.order(col, { ascending: true });
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length === 0) return rows;
  }
  throw new Error(
    `${table}: over ${MAX_PAGES * PAGE_SIZE} rows — refusing to write a truncated snapshot`
  );
}

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  return cronSecretMatches(req.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    // Not reported to client_errors: this route is reachable by anyone (cron
    // paths are excluded from middleware auth), so an unauthenticated request
    // proves nothing about whether CRON_SECRET is actually misconfigured — a
    // scanner hitting this URL would otherwise plant a false alarm that also
    // occupies the dedupe window, silencing that day's REAL failure report.
    // A genuinely rotated secret still shows up in Vercel's own invocation log.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!hasServiceRole()) return NextResponse.json({ error: "no service role" }, { status: 503 });
  if (!r2Configured()) {
    await reportCronFailure("backup", "R2 not configured — snapshot skipped entirely");
    return NextResponse.json({ error: "R2 not configured" }, { status: 503 });
  }

  const admin = createAdminClient();
  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const errors: Record<string, string> = {};

  // Tables in parallel, pages within a table in sequence — region-local round-trips
  // on a tiny dataset (~few hundred rows total, so most tables are 2 calls), well
  // within the function's time budget now that it runs in sin1. The whole snapshot is
  // held in memory and stringified, so this stays comfortable up to roughly 100k rows
  // (~50 MB of JSON); past that it needs streaming/NDJSON rather than a bigger page.
  await Promise.all(
    TABLES.map(async (t) => {
      try {
        const rows = await selectAll(admin, t);
        data[t] = rows;
        counts[t] = rows.length;
      } catch (e) {
        errors[t] = e instanceof Error ? e.message : String(e);
      }
    })
  );

  const generatedAt = new Date().toISOString();
  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
  const snapshot = {
    generatedAt,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    counts,
    errors,
    data,
  };
  // Colon/dot-free key so it's a clean filename on any OS when downloaded.
  const key = `backups/cueiq-snapshot-${generatedAt.replace(/[:.]/g, "-")}.json`;

  try {
    await r2Client().send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: JSON.stringify(snapshot),
        ContentType: "application/json",
      })
    );
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await reportCronFailure("backup", `upload to R2 failed — no snapshot written: ${detail}`);
    return NextResponse.json({ error: "upload failed", detail }, { status: 500 });
  }

  // Prune old snapshots — keep the most recent RETAIN. The key embeds the ISO
  // timestamp, so a plain lexicographic sort is chronological. Best-effort: a
  // pruning failure must never fail the backup we just wrote.
  let pruned = 0;
  try {
    const listed = await r2Client().send(
      new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: "backups/" })
    );
    const keys = (listed.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => !!k && k.endsWith(".json"))
      .sort();
    const stale = keys.slice(0, Math.max(0, keys.length - RETAIN));
    if (stale.length > 0) {
      await r2Client().send(
        new DeleteObjectsCommand({
          Bucket: R2_BUCKET,
          Delete: { Objects: stale.map((Key) => ({ Key })), Quiet: true },
        })
      );
      pruned = stale.length;
    }
  } catch {
    /* keep the fresh backup even if pruning the old ones fails */
  }

  // A snapshot with per-table errors is a genuinely incomplete backup, not a
  // healthy ok:true buried under a JSON nobody reads — surface it the same way
  // an outright upload failure already is, so platform-level monitoring (and the
  // Dev Inbox) both see it, and name which tables are missing from this snapshot.
  const failedTables = Object.keys(errors);
  if (failedTables.length > 0) {
    await reportCronFailure(
      "backup",
      `partial snapshot — ${failedTables.length} table(s) failed: ${failedTables.join(", ")}`,
      errors
    );
  }

  return NextResponse.json(
    {
      ok: failedTables.length === 0,
      key,
      tables: TABLES.length,
      rows: totalRows,
      pruned,
      errors,
    },
    { status: failedTables.length === 0 ? 200 : 500 }
  );
}
