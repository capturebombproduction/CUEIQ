// Client-side mirror of lib/queries.ts `getWorkspace` for the desktop SPA.
// The web version runs on the server (cookies + RSC); here we resolve the same
// data through the browser Supabase client (RLS applies identically via the
// user's session). Shape matches the web Workspace so reused components Just Work.
import { createClient } from "@/lib/supabase/client";
import { makePerms, type GroupRoleRow, type Perms } from "@/lib/permissions";
import type { Group, Role, Tenant } from "@/lib/types";
import { isOffline, readCache, writeCache } from "~/data/cache";

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
  // workspace from cache instead — but only if a session still exists locally, so
  // a signed-out device never resurfaces the previous user's data.
  if (isOffline()) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const cached = readCache<WorkspaceData>(WS_CACHE_KEY);
    if (session && cached) return cached;
    return empty(session?.user ? { id: session.user.id, email: session.user.email ?? null, name: null } : null);
  }

  // Flaky network even though navigator says online — getUser can reject; treat
  // any failure as "fall back to cache".
  const userResult = await supabase.auth.getUser().catch(() => null);
  if (!userResult) {
    const cached = readCache<WorkspaceData>(WS_CACHE_KEY);
    if (cached) return cached;
    return empty(null);
  }
  const user = userResult.data.user;
  if (!user) return empty(null);

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

  const [{ data: tenant }, { data: groups }, { data: groupRoleRows }] =
    await Promise.all([
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

  // membership read succeeded but the parallel reads didn't return a tenant — a
  // blip mid-batch. Don't clobber a good cache with this half-empty result.
  if (!tenant) {
    const cached = readCache<WorkspaceData>(WS_CACHE_KEY);
    if (cached && cached.user?.id === user.id && cached.membership) return cached;
  }

  const groupRoles = (groupRoleRows ?? []) as GroupRoleRow[];

  const ws: WorkspaceData = {
    user: base,
    membership: { tenant_id: memberRow.tenant_id as string, role },
    tenant: (tenant as Tenant) ?? null,
    groups: (groups ?? []) as Group[],
    groupRoles,
    perms: makePerms(role, groupRoles),
  };
  writeCache(WS_CACHE_KEY, ws);
  return ws;
}
