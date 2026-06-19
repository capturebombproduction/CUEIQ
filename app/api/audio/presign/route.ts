// ---------------------------------------------------------------------------
// POST /api/audio/presign
//
// Issues a short-lived presigned URL so the browser can PUT (upload) or GET
// (download) an audio object DIRECTLY to/from Cloudflare R2 — the big WAV bytes
// never pass through this serverless function. DELETE is performed server-side
// (no body, tiny op, no CORS needed on the bucket for it).
//
// Authorization mirrors exactly what Supabase Storage RLS used to enforce
// (supabase/migrations/0004): the tenant is the first segment of the object key,
// and we reuse the SECURITY DEFINER predicates is_tenant_member (read) and
// can_edit_tenant (write/delete) via the user's authenticated session.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient } from "@/lib/supabase/server";
import { r2Client, r2Configured, R2_BUCKET } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_TTL = 60 * 15; // 15 min — generous for a big WAV over venue Wi-Fi

type Op = "get" | "put" | "delete";

export async function POST(req: Request) {
  if (!r2Configured()) {
    return NextResponse.json(
      { error: "R2 ยังไม่ได้ตั้งค่า (ขาด R2_* env)" },
      { status: 503 }
    );
  }

  let body: { key?: string; op?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const key = (body.key ?? "").trim();
  const op = body.op as Op;
  if (
    !key ||
    key.startsWith("/") ||
    key.includes("..") ||
    !["get", "put", "delete"].includes(op)
  ) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  // The first path segment is the tenant id — gate access on it.
  const tenantId = key.split("/")[0];
  if (!UUID.test(tenantId)) {
    return NextResponse.json({ error: "bad key" }, { status: 400 });
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Reads need membership; writes/deletes need edit rights — same predicates as
  // the old Storage RLS, evaluated under the caller's auth.uid().
  const rpc = op === "get" ? "is_tenant_member" : "can_edit_tenant";
  const { data: allowed, error: rpcErr } = await supabase.rpc(rpc, {
    tid: tenantId,
  });
  if (rpcErr) {
    return NextResponse.json(
      { error: "permission check failed" },
      { status: 500 }
    );
  }
  if (!allowed) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const client = r2Client();

  try {
    if (op === "delete") {
      await client.send(
        new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })
      );
      return NextResponse.json({ ok: true });
    }

    const command =
      op === "put"
        ? new PutObjectCommand({ Bucket: R2_BUCKET, Key: key })
        : new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
    const url = await getSignedUrl(client, command, { expiresIn: URL_TTL });
    return NextResponse.json({ url });
  } catch (e) {
    console.error("[presign] R2 error:", e);
    return NextResponse.json({ error: "r2 error" }, { status: 502 });
  }
}
