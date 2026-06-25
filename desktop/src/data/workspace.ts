// Client-side mirror of lib/queries.ts `getWorkspace` for the desktop SPA.
// The web version runs on the server (cookies + RSC); here we resolve the same
// data through the browser Supabase client (RLS applies identically via the
// user's session). Shape matches the web Workspace so reused components Just Work.
import { createClient } from "@/lib/supabase/client";
import { makePerms, type GroupRoleRow, type Perms } from "@/lib/permissions";
import type { Group, Role, Tenant } from "@/lib/types";

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
  const {
    data: { user },
  } = await supabase.auth.getUser();
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

  if (!memberRow) return empty(base);

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

  const groupRoles = (groupRoleRows ?? []) as GroupRoleRow[];

  return {
    user: base,
    membership: { tenant_id: memberRow.tenant_id as string, role },
    tenant: (tenant as Tenant) ?? null,
    groups: (groups ?? []) as Group[],
    groupRoles,
    perms: makePerms(role, groupRoles),
  };
}
