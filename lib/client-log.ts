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
];

export async function logClientError(args: {
  userId: string;
  tenantId: string | null;
  kind: "error" | "unhandledrejection" | "react";
  message: string;
  stack?: string | null;
  url?: string | null;
}): Promise<void> {
  try {
    const message = (args.message || "").slice(0, 2000).trim();
    if (!message) return;
    if (IGNORE.some((re) => re.test(message))) return;
    if (logged >= MAX_PER_SESSION) return;
    const key = `${args.kind}:${message}`;
    if (seen.has(key)) return; // captured this exact error already this session
    seen.add(key);
    logged++;

    const supabase = createClient();
    await supabase.from("client_errors").insert({
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
  } catch {
    /* logging must never throw */
  }
}
