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
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient as createTokenClient } from "@supabase/supabase-js";
import { r2Client, r2Configured, R2_BUCKET } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_TTL = 60 * 15; // 15 min — generous for a big WAV over venue Wi-Fi

type Op = "get" | "put" | "delete";

// CORS — the WEB app calls this same-origin (these headers are inert there). The
// DESKTOP app calls it cross-origin with a Bearer token (no cookies), so reflect
// the caller's Origin and allow the Authorization header. Auth is still the real
// gate (a valid session/token + the per-band RLS predicates below), so reflecting
// the origin grants nothing a holder of the token couldn't already do.
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(req) });
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

/** Resolve the caller's Supabase client: a Bearer token (desktop, cross-origin)
 *  takes precedence; otherwise the cookie session (web, same-origin). Either way
 *  both auth.getUser() AND the RLS rpc() calls run as that user. */
async function callerClient(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (token) {
    return createTokenClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.trim(),
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      }
    );
  }
  return createServerClient();
}

export async function POST(req: Request) {
  if (!r2Configured()) {
    return json(req, { error: "R2 ยังไม่ได้ตั้งค่า (ขาด R2_* env)" }, 503);
  }

  let body: { key?: string; op?: string };
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "bad request" }, 400);
  }

  const key = (body.key ?? "").trim();
  const op = body.op as Op;
  if (
    !key ||
    key.startsWith("/") ||
    key.includes("..") ||
    !["get", "put", "delete"].includes(op)
  ) {
    return json(req, { error: "bad request" }, 400);
  }

  // Key layout (see lib/audio-remote.ts buildAudioPath / buildSongAudioPath):
  //   new:    <tenant>/<group>/<event>/<item>   and  <tenant>/<group>/songs/<song>
  //   legacy: <tenant>/<event>/<item>           (pre-RBAC, no group segment)
  // The first segment is always the tenant id; segment 1 is the band id when the
  // key is the new 4-part form. Gate per-BAND when we have a group, so a member of
  // one band can't fetch another band's audio (RBAC, supabase/migrations/0016).
  const segs = key.split("/");
  const tenantId = segs[0];
  if (!UUID.test(tenantId)) {
    return json(req, { error: "bad key" }, 400);
  }
  const groupId = segs.length >= 4 && UUID.test(segs[1]) ? segs[1] : null;

  const supabase = await callerClient(req);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return json(req, { error: "unauthorized" }, 401);
  }

  // Reads need view rights; writes/deletes need edit rights — evaluated under the
  // caller's auth.uid() via the SECURITY DEFINER RLS helpers. Group-scoped keys
  // gate on the band; legacy keys fall back to the tenant-level predicates.
  const { rpc, arg } = groupId
    ? {
        rpc: op === "get" ? "can_view_group" : "can_edit_group",
        arg: { gid: groupId },
      }
    : {
        rpc: op === "get" ? "is_tenant_member" : "can_edit_tenant",
        arg: { tid: tenantId },
      };
  const { data: allowed, error: rpcErr } = await supabase.rpc(rpc, arg);
  if (rpcErr) {
    return json(req, { error: "permission check failed" }, 500);
  }
  if (!allowed) {
    return json(req, { error: "forbidden" }, 403);
  }

  const client = r2Client();

  try {
    if (op === "delete") {
      await client.send(
        new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })
      );
      return json(req, { ok: true });
    }

    const command =
      op === "put"
        ? new PutObjectCommand({ Bucket: R2_BUCKET, Key: key })
        : new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
    const url = await getSignedUrl(client, command, { expiresIn: URL_TTL });
    return json(req, { url });
  } catch (e) {
    console.error("[presign] R2 error:", e);
    return json(req, { error: "r2 error" }, 502);
  }
}
