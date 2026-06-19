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

import { S3Client } from "@aws-sdk/client-s3";

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
