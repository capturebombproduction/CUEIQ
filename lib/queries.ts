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

export interface Workspace {
  user: { id: string; email: string | null; name: string | null } | null;
  membership: { tenant_id: string; role: Role } | null;
  tenant: Tenant | null;
  groups: Group[];
}

/** Resolve the signed-in user's tenant, role and groups (MVP: one tenant). */
export async function getWorkspace(): Promise<Workspace> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { user: null, membership: null, tenant: null, groups: [] };
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
    return { user: base, membership: null, tenant: null, groups: [] };
  }

  const [{ data: tenant }, { data: groups }] = await Promise.all([
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
  ]);

  return {
    user: base,
    membership: {
      tenant_id: memberRow.tenant_id as string,
      role: memberRow.role as Role,
    },
    tenant: (tenant as Tenant) ?? null,
    groups: (groups ?? []) as Group[],
  };
}

export interface EventBundle {
  event: EventRow & { group: Group | null };
  schedule: ScheduleItem[];
  setlist: SetlistItem[];
  micMap: MicAssignment[];
  members: Member[];
  role: Role | null;
}

/** Load a single event with all of its child data, or null if not accessible. */
export async function getEventBundle(
  eventId: string
): Promise<EventBundle | null> {
  const supabase = createClient();

  const { data: event } = await supabase
    .from("events")
    .select("*, groups(*)")
    .eq("id", eventId)
    .maybeSingle();

  if (!event) return null;

  const { data: membership } = await supabase
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", event.tenant_id)
    .maybeSingle();

  const [schedule, setlist, micMap, members] = await Promise.all([
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
    role: (membership?.role as Role) ?? null,
  };
}

/** All songs in the tenant's library (newest first). */
export async function getSongs(tenantId: string): Promise<Song[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from("songs")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  return (data ?? []) as Song[];
}
