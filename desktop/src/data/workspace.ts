// Client-side mirror of lib/queries.ts `getWorkspace` for the desktop SPA.
// The web version runs on the server (cookies + RSC); here we resolve the same
// data through the browser Supabase client (RLS applies identically via the
// user's session). Shape matches the web Workspace so reused components Just Work.
import { createClient } from "@/lib/supabase/client";
import { makePerms, type GroupRoleRow, type Perms } from "@/lib/permissions";
import type { Group, Role, Tenant } from "@/lib/types";
import { isOffline, readCache, writeCache } from "~/data/cache";
import { getStoredSessionUser } from "~/data/stored-session";

const WS_CACHE_KEY = "workspace";

export interface WorkspaceData {
  user: { id: string; email: string | null; name: string | null } | null;
  membership: { tenant_id: string; role: Role } | null;
  tenant: Tenant | null;
  groups: Group[];
  groupRoles: GroupRoleRow[];
  perms: Perms;
}

const empty = (
  user: WorkspaceData["user"]
): WorkspaceData => ({
  user,
  membership: null,
  tenant: null,
  groups: [],
  groupRoles: [],
  perms: makePerms(null),
});

export async function loadWorkspace(): Promise<WorkspaceData> {
  const supabase = createClient();

  // Offline: the table reads below all need the network, so serve the last good
  // workspace from cache instead — but only if a persisted session still exists
  // AND the cache belongs to that same user (sign-out wipes both — see App.tsx —
  // but a shared band device must never resurface another account's workspace).
  // Identity comes from the RAW stored session, NOT getSession(): with an expired
  // access token getSession() tries a network refresh and returns null offline
  // (the /login bounce this offline pass exists to prevent) — the stored session
  // survives network failures and only disappears on a real sign-out.
  if (isOffline()) {
    const stored = getStoredSessionUser();
    const cached = readCache<WorkspaceData>(WS_CACHE_KEY);
    if (stored && cached && cached.user?.id === stored.id) return cached;
    return empty(stored ? { id: stored.id, email: stored.email, name: null } : null);
  }

  // Flaky network even though navigator says online (venue router, no internet):
  // auth-js resolves getUser() with `user: null` on a network failure rather than
  // rejecting, so treat null-user and rejection the SAME — fall back to the cache
  // under the stored-identity owner check (an instant storage read, no doomed
  // refresh attempt). A genuinely signed-out device has no stored session, so it
  // still lands on empty().
  const userResult = await supabase.auth.getUser().catch(() => null);
  const user = userResult?.data.user ?? null;
  if (!user) {
    const stored = getStoredSessionUser();
    const cached = readCache<WorkspaceData>(WS_CACHE_KEY);
    if (stored && cached && cached.user?.id === stored.id) return cached;
    return empty(null);
  }

  const name =
    (user.user_metadata?.full_name as string | undefined) ?? user.email ?? null;
  const base = { id: user.id, email: user.email ?? null, name };

  const { data: memberRow } = await supabase
    .from("tenant_members")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!memberRow) {
    // No membership found — but a transient network blip can also yield null.
    // If we have a cached workspace for this same user, trust it over an empty.
    const cached = readCache<WorkspaceData>(WS_CACHE_KEY);
    if (cached && cached.user?.id === user.id && cached.membership) return cached;
    return empty(base);
  }

  const role = memberRow.role as Role;

  const [tenantRes, groupsRes, groupRolesRes] = await Promise.all([
    supabase
      .from("tenants")
      .select("*")
      .eq("id", memberRow.tenant_id)
      .maybeSingle(),
    supabase
      .from("groups")
      .select("*")
      .eq("tenant_id", memberRow.tenant_id)
      .order("created_at", { ascending: true }),
    supabase
      .from("group_roles")
      .select("group_id, role")
      .eq("user_id", user.id),
  ]);
  const tenant = tenantRes.data;

  // membership read succeeded but the parallel batch blipped — either no tenant
  // came back, or a groups/group_roles read errored (postgrest resolves network
  // failures as { data: null, error }, so an errored read must not become empty
  // groups/groupRoles). Don't clobber a good cache with this half-empty result.
  const blipped = Boolean(tenantRes.error || groupsRes.error || groupRolesRes.error);
  if (!tenant || blipped) {
    const cached = readCache<WorkspaceData>(WS_CACHE_KEY);
    if (cached && cached.user?.id === user.id && cached.membership) return cached;
  }

  const groupRoles = (groupRolesRes.data ?? []) as GroupRoleRow[];

  const ws: WorkspaceData = {
    user: base,
    membership: { tenant_id: memberRow.tenant_id as string, role },
    tenant: (tenant as Tenant) ?? null,
    groups: (groupsRes.data ?? []) as Group[],
    groupRoles,
    perms: makePerms(role, groupRoles),
  };
  // Cache only a COMPLETE read: a tenant-less or errored result here means the
  // parallel batch blipped (and there was no cache to fall back on) — don't make
  // it the offline copy.
  if (ws.tenant && !blipped) writeCache(WS_CACHE_KEY, ws);
  return ws;
}
