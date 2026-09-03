"use client";

// Self-contained client-error capture into public.client_errors (NO Sentry / no
// external service — stays free + in our own Supabase). Best-effort, deduped, and
// throttled, and it swallows its OWN failures so logging can never cascade into
// more errors. Only meaningful for authenticated users (RLS gates the insert).

import { createClient } from "@/lib/supabase/client";
import { APP_VERSION } from "@/lib/app-version";

const seen = new Set<string>();
let logged = 0;
const MAX_PER_SESSION = 12;

// Browser noise that isn't actionable — never stored.
const IGNORE = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /^Load failed$/i,
  /^Failed to fetch$/i, // transient network blips; the app already retries/handles these
  // Hydration-class errors are, in this PWA, almost always a DEPLOY-WINDOW
  // mismatch: a client still running an OLD service-worker-cached JS chunk against
  // freshly-deployed SSR HTML. They self-recover once the SW updates, so they're
  // noise that buries real bugs — a genuine logic error surfaces with a different
  // message. (#418/420/421/422/423/425 = hydration mismatch, #419 = Suspense SSR.)
  /Minified React error #(418|419|420|421|422|423|425)\b/i,
  /hydrat/i, // "Hydration failed", "error while hydrating", "hydrating this Suspense boundary"
  /Text content does not match server-rendered HTML/i,
];

// Dev-origin: our OWN local debugging, never a user hitting a prod problem.
function isDevOrigin(url?: string | null, stack?: string | null): boolean {
  if (typeof location !== "undefined") {
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h.endsWith(".local"))
      return true;
  }
  // dev-only module scheme (HMR) — never emitted by a production build.
  if (url?.startsWith("webpack-internal:")) return true;
  if (stack?.includes("webpack-internal:")) return true;
  return false;
}

/**
 * @returns whether the row actually reached the server. Nothing about capture
 * changes on a false — this stays best-effort and still never throws — but the
 * ANSWER now exists, because something downstream tells the user "ระบบบันทึก
 * ปัญหานี้ไว้ให้แล้ว" and that sentence had never been checked against anything.
 * A promise nobody verifies is the write-guard class of bug (lib/write-guard.ts),
 * one step worse: it is told to a person.
 *
 * ⚠️ SUCCESS IS `!error`, DELIBERATELY NOT A ROW COUNT. The house rule is that a
 * write returning no error and no row did not happen — but it cannot be applied
 * here, because `client_errors_select` is `can_admin_tenant(tenant_id)` BY DESIGN:
 * an ordinary member may INSERT and may not read back. `.select()` would therefore
 * return zero rows on a perfectly good insert for eighteen of nineteen accounts,
 * and we would answer "not saved" every time it actually was.
 */
export async function logClientError(args: {
  userId: string;
  tenantId: string | null;
  kind: "error" | "unhandledrejection" | "react";
  message: string;
  stack?: string | null;
  url?: string | null;
}): Promise<boolean> {
  try {
    const message = (args.message || "").slice(0, 2000).trim();
    if (!message) return false;
    if (IGNORE.some((re) => re.test(message))) return false;
    if (isDevOrigin(args.url, args.stack)) return false;
    if (logged >= MAX_PER_SESSION) return false;
    const key = `${args.kind}:${message}`;
    if (seen.has(key)) return false; // captured this exact error already this session
    seen.add(key);
    logged++;

    const supabase = createClient();
    const { error } = await supabase.from("client_errors").insert({
      tenant_id: args.tenantId,
      user_id: args.userId,
      kind: args.kind,
      message,
      stack: args.stack ? args.stack.slice(0, 6000) : null,
      url: args.url ?? (typeof location !== "undefined" ? location.href : null),
      user_agent:
        typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 400) : null,
      app_version: APP_VERSION,
    });
    return !error;
  } catch {
    /* logging must never throw */
    return false;
  }
}
