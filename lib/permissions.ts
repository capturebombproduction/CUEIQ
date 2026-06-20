// ---------------------------------------------------------------------------
// Effective per-band permissions — the TypeScript mirror of the SECURITY DEFINER
// helpers in supabase/migrations/0016_rbac_roles.sql. The DATABASE (RLS) is the
// real enforcer; these are for the UI to hide/show controls so users aren't
// offered actions the DB will reject.
//
//   Tenant tier:  admin / ceo / label_staff  (label-wide standing)
//   Group tier:   artist_manager (Ar) / member  (per-band, in group_roles)
// ---------------------------------------------------------------------------
import {
  isTenantAdmin,
  isLabelWide,
  isApprover,
  type Group,
  type GroupRole,
  type Role,
} from "@/lib/types";

export interface GroupRoleRow {
  group_id: string;
  role: GroupRole;
}

/** Everything the UI needs to reason about what the current user may do. */
export interface Perms {
  tenantRole: Role | null;
  groupRoles: GroupRoleRow[];
}

export function makePerms(
  tenantRole: Role | null,
  groupRoles: GroupRoleRow[] = []
): Perms {
  return { tenantRole, groupRoles };
}

/** The user's per-band role (own group_roles row), or null. */
export function groupRoleOf(p: Perms, groupId: string): GroupRole | null {
  return p.groupRoles.find((g) => g.group_id === groupId)?.role ?? null;
}

export function isAdmin(p: Perms): boolean {
  return isTenantAdmin(p.tenantRole);
}

/** Sees every band in the tenant (admin / ceo / label_staff). */
export function isLabelWideUser(p: Perms): boolean {
  return isLabelWide(p.tenantRole);
}

/** May approve/reject songs + events (admin / label_staff). */
export function canApprove(p: Perms): boolean {
  return isApprover(p.tenantRole);
}

/** Can SEE a band's data: label-wide, or has any group_roles row for it. */
export function canViewGroup(p: Perms, groupId: string): boolean {
  return isLabelWideUser(p) || groupRoleOf(p, groupId) !== null;
}

/** Can EDIT a band's events/roster: admin, or the band's Ar. */
export function canEditGroup(p: Perms, groupId: string): boolean {
  return isAdmin(p) || groupRoleOf(p, groupId) === "artist_manager";
}

/** Can create a new event for at least one band (drives the "New Event" CTA). */
export function canCreateAnyEvent(p: Perms): boolean {
  return isAdmin(p) || p.groupRoles.some((g) => g.role === "artist_manager");
}

/** Can edit at least one band's events/roster (admin, or an Ar somewhere). */
export function canEditAnyGroup(p: Perms): boolean {
  return canCreateAnyEvent(p);
}

/** The subset of `groups` the user may edit (drives band dropdowns + roster). */
export function editableGroups(p: Perms, groups: Group[]): Group[] {
  return groups.filter((g) => canEditGroup(p, g.id));
}

/**
 * May open a full event detail / editor page. label_staff is OVERVIEW-ONLY
 * (they act on events from /overview, never the full event workspace); everyone
 * else who can VIEW the event (admin / ceo / the band's Ar+members) may open it.
 */
export function canOpenEventDetail(p: Perms): boolean {
  return p.tenantRole !== "label_staff";
}

/** Can edit the photo-time of an event whose band has self_photo = false. */
export function canEditPhotoTime(
  p: Perms,
  groupId: string,
  groupSelfPhoto: boolean
): boolean {
  return canEditGroup(p, groupId) || (canApprove(p) && !groupSelfPhoto);
}

/**
 * Real-time editing INSIDE Live Mode (quick-reorder/drag) AND saving the
 * "จบโชว์" last-run record are ADMIN-ONLY. Ar/Member may rehearse playback only;
 * Ar edits the setlist in advance via the normal editor, not during the show.
 */
export function canLiveEdit(p: Perms): boolean {
  return isAdmin(p);
}
