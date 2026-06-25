import { NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { r2Client, r2Configured, R2_BUCKET } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Daily off-machine snapshot (Vercel Cron → see vercel.json). Dumps every public
// table via the service-role client and writes ONE JSON to R2 under backups/ — so
// the live label data survives this machine dying, without any external service
// (R2 is already wired for audio). Mirrors scripts/backup.mjs but runs in prod and
// lands OFF this box. The R2 backups/ prefix is never presigned/served, so it isn't
// publicly reachable. Gate is the same CRON_SECRET Bearer the reminders job uses.
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

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasServiceRole()) return NextResponse.json({ error: "no service role" }, { status: 503 });
  if (!r2Configured()) return NextResponse.json({ error: "R2 not configured" }, { status: 503 });

  const admin = createAdminClient();
  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const errors: Record<string, string> = {};

  // One region-local round-trip per table, in parallel — tiny dataset (~few hundred
  // rows total), well within the function's time budget now that it runs in sin1.
  await Promise.all(
    TABLES.map(async (t) => {
      const { data: rows, error } = await admin.from(t).select("*");
      if (error) {
        errors[t] = error.message;
        return;
      }
      data[t] = rows ?? [];
      counts[t] = (rows ?? []).length;
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
    return NextResponse.json(
      { error: "upload failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, key, tables: TABLES.length, rows: totalRows, errors });
}
