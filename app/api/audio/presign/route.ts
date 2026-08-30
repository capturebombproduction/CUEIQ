// ---------------------------------------------------------------------------
// POST /api/audio/presign
//
// Issues a short-lived presigned URL so the browser can PUT (upload) or GET
// (download) an audio object DIRECTLY to/from Cloudflare R2 — the big WAV bytes
// never pass through this serverless function. DELETE is performed server-side
// (no body, tiny op, no CORS needed on the bucket for it).
//
// Authorization mirrors what the matching RLS policy would say, and the RULE
// ITSELF lives in lib/presign-authz.ts — key layouts, who may read, who may write,
// and which SECURITY DEFINER predicate answers each. That module is pure and
// exhaustively tested; this file signs URLs and nothing else.
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
import { planPresign, type PresignOp } from "@/lib/presign-authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const URL_TTL = 60 * 15; // 15 min — generous for a big WAV over venue Wi-Fi

type Op = PresignOp;

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

  const supabase = await callerClient(req);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return json(req, { error: "unauthorized" }, 401);
  }

  // The whole rule — which key layouts exist and who may touch each — lives in
  // lib/presign-authz.ts, exhaustively tested there. This handler only executes
  // the plan it returns.
  const plan = planPresign(key, op, user.id);
  if (plan.decision === "bad-key") return json(req, { error: "bad request" }, 400);
  if (plan.decision === "deny") return json(req, { error: "forbidden" }, 403);

  let allowed: unknown = plan.decision === "allow";
  if (plan.decision === "ask") {
    // Evaluated under the CALLER'S auth.uid() via the SECURITY DEFINER RLS helpers,
    // never with the service role.
    const { data, error: rpcErr } = await supabase.rpc(plan.rpc, plan.arg);
    if (rpcErr) {
      return json(req, { error: "permission check failed" }, 500);
    }
    allowed = data;
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
