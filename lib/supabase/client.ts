import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client for use in Client Components (browser).
 * Uses the public publishable key from NEXT_PUBLIC_SUPABASE_ANON_KEY.
 */
export function createClient() {
  // .trim() guards against a trailing newline/space pasted into the env value —
  // a stray "\n" corrupts the Realtime WebSocket apikey (?apikey=...%0A) and
  // breaks multi-device sync with CHANNEL_ERROR / transport failure.
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.trim()
  );
}
