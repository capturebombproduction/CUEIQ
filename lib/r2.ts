// ---------------------------------------------------------------------------
// Cloudflare R2 — server-only S3 client for the audio backend.
//
// The audio BYTES live in R2 (S3-compatible, zero egress fees, no per-file size
// cap — ideal for the real WAV masters at 27–88 MB). Supabase still owns auth +
// all metadata; setlist_items.audio_path holds the R2 object key (same path
// convention as before, so no DB migration was needed).
//
// This module is imported ONLY by the presign route handler — never by client
// code — so the AWS SDK never reaches the browser bundle. Env is read lazily at
// request time so `next build` and an un-configured dev box don't crash on import.
// ---------------------------------------------------------------------------

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const R2_BUCKET = process.env.R2_BUCKET ?? "";

export function r2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      R2_BUCKET
  );
}

let _client: S3Client | null = null;

export function r2Client(): S3Client {
  if (_client) return _client;

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey || !R2_BUCKET) {
    throw new Error("R2 is not configured (missing R2_* env vars)");
  }

  _client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // R2 rejects the AWS "flexible checksum" trailers the v3 SDK now adds by
    // default — they'd be baked into the presigned PUT signature but the plain
    // browser fetch can't reproduce them → 403. Only add a checksum when an
    // operation actually requires one (none of ours do).
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return _client;
}

export interface BackupObject {
  key: string;
  size: number;
  lastModified: string; // ISO
}

/**
 * Off-machine DB snapshots under the backups/ prefix (written by the daily backup
 * cron), newest first. Empty when R2 isn't configured. Server-only — used by the
 * Admin backup panel + the gated download route.
 */
export async function listBackups(): Promise<BackupObject[]> {
  if (!r2Configured()) return [];
  const client = r2Client();
  const out: BackupObject[] = [];
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: "backups/",
        ContinuationToken: token,
      })
    );
    for (const o of res.Contents ?? []) {
      if (!o.Key || o.Key.endsWith("/")) continue; // skip the folder placeholder
      out.push({
        key: o.Key,
        size: o.Size ?? 0,
        lastModified: (o.LastModified ?? new Date(0)).toISOString(),
      });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  out.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1)); // newest first
  return out;
}

/**
 * Short-lived presigned GET for a backup object, forced to download (not display).
 * Refuses any key outside backups/ so this can never be used to sign the audio
 * masters or anything else in the bucket. Caller MUST gate on admin first.
 */
export async function presignBackupGet(key: string, expiresSec = 60): Promise<string> {
  if (!key.startsWith("backups/")) throw new Error("refusing to sign a non-backup key");
  const filename = key.split("/").pop() || "backup.json";
  return getSignedUrl(
    r2Client(),
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    }),
    { expiresIn: expiresSec }
  );
}

/**
 * Total bytes + object count stored in the bucket — for the Admin storage gauge.
 * Returns null when R2 isn't configured. Paginates through every object (ListV2
 * is a Class A op; one or a few calls for a small label). Server-only.
 */
export async function getR2Usage(): Promise<{ bytes: number; count: number } | null> {
  if (!r2Configured()) return null;
  const client = r2Client();
  let token: string | undefined;
  let bytes = 0;
  let count = 0;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: R2_BUCKET, ContinuationToken: token })
    );
    for (const o of res.Contents ?? []) {
      bytes += o.Size ?? 0;
      count += 1;
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return { bytes, count };
}
