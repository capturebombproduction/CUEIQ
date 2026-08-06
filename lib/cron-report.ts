import { createHash, timingSafeEqual } from "node:crypto";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";

// Cron jobs run unattended (Vercel Cron → no human ever looks at the response
// body). The failure mode that used to be invisible: a partial backup (or a
// mid-run exception) returning ok:true — or a 500 nobody reads — with the real
// cause buried in a JSON nobody opens. Route it through the SAME table the
// in-app ErrorMonitor/feedback pipeline already writes to (client_errors) — the
// admin Dev Inbox "ปัญหา" tab is a place someone already checks, instead of a
// second surface to build and eventually forget to look at.
//
// Deliberately NOT used for the unauthorized (401) branch: middleware excludes
// /api/*, so these routes are reachable by anyone, and an anonymous caller
// proves nothing about whether CRON_SECRET itself is actually wrong — a
// scanner or a pasted-into-a-browser URL would plant a false alarm here just
// as easily as a genuinely rotated secret would. Vercel's own invocation log
// already records the daily cron run's status code, so a real secret mismatch
// still surfaces — just there, not here.
//
// Best-effort + deduped: a route with no SUPABASE_SERVICE_ROLE_KEY can't reach
// this table at all — the same admin client is how it would write anything else
// — so in that case the caller's non-200 HTTP status is the only signal left,
// same as any other total outage. Deduped per route over DEDUPE_HOURS so a
// genuine repeat failure can't flood the table with one row per request; a
// human only needs to be told once per window.
const DEDUPE_HOURS = 6;

export async function reportCronFailure(
  route: string,
  message: string,
  detail?: Record<string, unknown>
): Promise<void> {
  if (!hasServiceRole()) return;
  try {
    const admin = createAdminClient();
    const url = `/api/cron/${route}`;
    const since = new Date(Date.now() - DEDUPE_HOURS * 3_600_000).toISOString();
    const { data: recent } = await admin
      .from("client_errors")
      .select("id")
      .eq("kind", "cron")
      .eq("url", url)
      .gt("created_at", since)
      .limit(1);
    if (recent && recent.length > 0) return; // already told about this route recently

    // client_errors_select is gated on can_admin_tenant(tenant_id), which is
    // FALSE for a null tenant_id (app_tenant_role finds no membership row to
    // match against) — a cron failure logged with tenant_id: null would insert
    // fine (service role bypasses RLS) but then be invisible to every admin
    // reading through the normal authenticated client, i.e. right back to
    // silent. This deployment is single-tenant (the Dev Inbox itself assumes
    // exactly one row via .single() elsewhere), so attach that tenant.
    const { data: tenant } = await admin.from("tenants").select("id").limit(1).maybeSingle();

    await admin.from("client_errors").insert({
      tenant_id: tenant?.id ?? null,
      user_id: null,
      kind: "cron",
      message: `[${route}] ${message}`,
      stack: detail ? JSON.stringify(detail).slice(0, 6000) : null,
      url,
      user_agent: null,
      app_version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    });
  } catch {
    /* the HTTP status code the caller returns is the fallback signal */
  }
}

/**
 * Constant-time Bearer-token check for the Vercel Cron `Authorization` header.
 * A plain `===` short-circuits on the first mismatched byte, so response time
 * leaks how many leading characters of a guessed CRON_SECRET were right —
 * `timingSafeEqual` needs equal-length buffers to be constant-time, and a
 * naive length check before it just relocates the leak to the length itself
 * (most guesses aren't even the right length). Hashing both sides first fixes
 * the compared length at 32 bytes regardless of the input, closing that gap too.
 */
export function cronSecretMatches(header: string, expected: string): boolean {
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
