// Persisted live-authority helpers (P2) over the show_authority table (mig 0035).
// They are the SYNCED MIRROR of each device's local role — the realtime hand-off
// still rides the existing live: broadcast channel; this layer lets a device that
// joins / reconnects / was offline SEE who holds a role, recover a ghost main
// (a holder whose heartbeat went stale), and (P3) decide a rank override.
//
// Every call is best-effort: offline or any error resolves to a no-op / empty so
// it can NEVER block or break the zero-tolerance live path. See
// docs/offline-first-plan.md §3/§6/§7.

// Absolute path (not "./supabase/client") so the desktop build's
// "@/lib/supabase/client" alias swaps in the localStorage-backed client too —
// a relative import would bypass the alias and pull the web's cookie client,
// which can't authenticate under Electron's file:// origin.
import { createClient } from "@/lib/supabase/client";
import type { Role } from "./types";

export type AuthorityKind = "show_main" | "audio_host";

export interface AuthorityRow {
  event_id: string;
  kind: AuthorityKind;
  device_id: string;
  device_label: string | null;
  by_user_id: string | null;
  by_role: string | null;
  claimed_at: string;
  heartbeat_at: string;
}

// Break-glass rank (higher = more authority): member < Ar < label_staff < ceo < admin.
const RANK: Record<string, number> = {
  member: 0,
  artist_manager: 1,
  label_staff: 2,
  ceo: 3,
  admin: 4,
};

export function rankOf(role: string | null | undefined): number {
  return role ? (RANK[role] ?? 0) : 0;
}

/** A strictly higher rank may force-take a role from the current holder (P3). */
export function canOverride(
  holderRole: string | null,
  myRole: string | null
): boolean {
  return rankOf(myRole) > rankOf(holderRole);
}

// A claim is "live" only while its heartbeat is fresh; older = ghost (the holding
// device crashed / left without releasing) → safe for another device to reclaim.
export const GHOST_MS = 90_000;

export function isGhost(row: AuthorityRow, now: number = Date.now()): boolean {
  const t = new Date(row.heartbeat_at).getTime();
  return !Number.isFinite(t) || now - t > GHOST_MS;
}

export interface ClaimInfo {
  deviceId: string;
  deviceLabel?: string | null;
  userId?: string | null;
  role?: Role | null;
}

/** Both authority rows for an event. Best-effort: [] on failure / offline. */
export async function getAuthority(eventId: string): Promise<AuthorityRow[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("show_authority")
      .select("*")
      .eq("event_id", eventId);
    if (error || !data) return [];
    return data as AuthorityRow[];
  } catch {
    return [];
  }
}

/** Claim (or hand-off-to-self / refresh) a role for this device — an upsert on
 *  (event_id, kind). Sets claimed_at + heartbeat_at. Returns whether it stuck. */
export async function claimAuthority(
  tenantId: string,
  eventId: string,
  kind: AuthorityKind,
  info: ClaimInfo
): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    const supabase = createClient();
    const { error } = await supabase.from("show_authority").upsert(
      {
        tenant_id: tenantId,
        event_id: eventId,
        kind,
        device_id: info.deviceId,
        device_label: info.deviceLabel ?? null,
        by_user_id: info.userId ?? null,
        by_role: info.role ?? null,
        claimed_at: now,
        heartbeat_at: now,
      },
      { onConflict: "event_id,kind" }
    );
    return !error;
  } catch {
    return false;
  }
}

/** Refresh the heartbeat for a role THIS device holds (no-op if it doesn't). */
export async function heartbeatAuthority(
  eventId: string,
  kind: AuthorityKind,
  deviceId: string
): Promise<void> {
  try {
    const supabase = createClient();
    await supabase
      .from("show_authority")
      .update({ heartbeat_at: new Date().toISOString() })
      .eq("event_id", eventId)
      .eq("kind", kind)
      .eq("device_id", deviceId);
  } catch {
    /* best-effort */
  }
}

/** Release a role THIS device holds (delete only if device_id matches mine, so it
 *  never clobbers a hand-off that already moved the row to another device). */
export async function releaseAuthority(
  eventId: string,
  kind: AuthorityKind,
  deviceId: string
): Promise<void> {
  try {
    const supabase = createClient();
    await supabase
      .from("show_authority")
      .delete()
      .eq("event_id", eventId)
      .eq("kind", kind)
      .eq("device_id", deviceId);
  } catch {
    /* best-effort */
  }
}
