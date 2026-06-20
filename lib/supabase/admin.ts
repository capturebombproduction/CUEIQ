import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * SERVICE-ROLE Supabase client — bypasses RLS. Server-only; NEVER import this
 * into a Client Component or expose the key to the browser. Used by the admin
 * account-provisioning route to create auth users + assign roles (operations
 * self-signup can't do, since signups are disabled).
 *
 * The key lives in SUPABASE_SERVICE_ROLE_KEY (.env.local + Vercel). When it is
 * absent the admin features degrade gracefully — callers check `hasServiceRole()`
 * first and show a setup notice instead of crashing.
 */
export function hasServiceRole(): boolean {
  return !!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
}

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  }
  return createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
