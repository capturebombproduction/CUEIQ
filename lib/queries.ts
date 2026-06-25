import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type {
  EventRow,
  Group,
  MicAssignment,
  Member,
  Role,
  ScheduleItem,
  SetlistItem,
  Song,
  Tenant,
} from "@/lib/types";
import { makePerms, type GroupRoleRow, type Perms } from "@/lib/permissions";

export interface Workspace {
  user: { id: string; email: string | null; name: string | null } | null;
  membership: { tenant_id: string; role: Role } | null;
  tenant: Tenant | null;
  groups: Group[];
  /** The user's per-band roles (group_roles rows the user owns). */
  groupRoles: GroupRoleRow[];
  /** Effective permissions for the UI (mirror of the DB's RLS helpers). */
  perms: Perms;
}

/**
 * Resolve the signed-in user's tenant, role and groups (MVP: one tenant).
 * Wrapped in React.cache so the (app) layout AND the page can both call it within
 * one request and it only runs once (dedupes the getUser + workspace queries per
 * navigation — request-scoped, NOT cross-request, so no staleness).
 */
export const getWorkspace = cache(async (): Promise<Workspace> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      user: null,
      membership: null,
      tenant: null,
      groups: [],
      groupRoles: [],
      perms: makePerms(null),
    };
  }

  const name =
    (user.user_metadata?.full_name as string | undefined) ??
    user.email ??
    null;
  const base = { id: user.id, email: user.email ?? null, name };

  const { data: memberRow } = await supabase
    .from("tenant_members")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!memberRow) {
    return {
      user: base,
      membership: null,
      tenant: null,
      groups: [],
      groupRoles: [],
      perms: makePerms(null),
    };
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

  const groupRoles = (groupRoleRows ?? []) as GroupRoleRow[];

  return {
    user: base,
    membership: {
      tenant_id: memberRow.tenant_id as string,
      role,
    },
    tenant: (tenant as Tenant) ?? null,
    groups: (groups ?? []) as Group[],
    groupRoles,
    perms: makePerms(role, groupRoles),
  };
});

export interface EventBundle {
  event: EventRow & { group: Group | null };
  schedule: ScheduleItem[];
  setlist: SetlistItem[];
  micMap: MicAssignment[];
  members: Member[];
  songs: Song[];
  lineup: string[]; // member_ids performing at this event (empty = not chosen yet)
}

/** Load a single event with all of its child data, or null if not accessible.
 * cache()-wrapped so repeated calls within one request are deduped. */
export const getEventBundle = cache(async (
  eventId: string
): Promise<EventBundle | null> => {
  const supabase = await createClient();

  const { data: event } = await supabase
    .from("events")
    .select("*, groups(*)")
    .eq("id", eventId)
    .maybeSingle();

  if (!event) return null;

  const [schedule, setlist, micMap, members, songs, lineup] = await Promise.all([
    supabase
      .from("schedule_items")
      .select("*")
      .eq("event_id", eventId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("setlist_items")
      .select("*")
      .eq("event_id", eventId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("mic_assignments")
      .select("*")
      .eq("event_id", eventId)
      .order("mic_number", { ascending: true })
      .order("order_index", { ascending: true }),
    supabase
      .from("members")
      .select("*")
      .eq("group_id", event.group_id)
      .order("sort_order", { ascending: true }),
    supabase
      .from("songs")
      .select("*")
      .eq("group_id", event.group_id)
      .order("title", { ascending: true }),
    supabase
      .from("event_members")
      .select("member_id")
      .eq("event_id", eventId),
  ]);

  return {
    event: {
      ...(event as unknown as EventRow),
      group: (event.groups as unknown as Group) ?? null,
    },
    schedule: (schedule.data ?? []) as ScheduleItem[],
    setlist: (setlist.data ?? []) as SetlistItem[],
    micMap: (micMap.data ?? []) as MicAssignment[],
    members: (members.data ?? []) as Member[],
    songs: (songs.data ?? []) as Song[],
    lineup: ((lineup.data ?? []) as { member_id: string }[]).map((r) => r.member_id),
  };
});

/** Members in the tenant, grouped-ordered. Pass `groupIds` to scope to a subset
 * of bands (band-tier users see only their own; omit for the whole tenant). */
export async function getMembers(
  tenantId: string,
  groupIds?: string[]
): Promise<Member[]> {
  const supabase = await createClient();
  const base = supabase.from("members").select("*").eq("tenant_id", tenantId);
  const scoped = groupIds ? base.in("group_id", groupIds) : base;
  const { data } = await scoped
    .order("group_id", { ascending: true })
    .order("sort_order", { ascending: true });
  return (data ?? []) as Member[];
}

/** Songs in the tenant's library (newest first). Pass `groupIds` to scope to a
 * subset of bands (band-tier users see only their own; omit for the whole
 * tenant). An empty array returns nothing — correct for a user with no bands. */
export async function getSongs(
  tenantId: string,
  groupIds?: string[]
): Promise<Song[]> {
  const supabase = await createClient();
  const base = supabase.from("songs").select("*").eq("tenant_id", tenantId);
  const scoped = groupIds ? base.in("group_id", groupIds) : base;
  const { data } = await scoped.order("created_at", { ascending: false });
  return (data ?? []) as Song[];
}
