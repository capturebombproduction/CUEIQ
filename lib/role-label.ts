import { ROLE_SHORT, type Role } from "@/lib/types";
import { isLabelWideUser, type Perms } from "@/lib/permissions";

/**
 * What role to show for the signed-in account. Band-scoped accounts all carry an
 * inert tenant role of `member`, so for them we surface their REAL per-band role
 * (Ar if they manage any band, otherwise สมาชิก) instead of the misleading tenant
 * label. Label-wide accounts (admin/ceo/label_staff) show the tenant role.
 *
 * Plain module, not a component file: the web (app) layout is a SERVER component
 * and calls this to build the account panel's identity line; the desktop shell
 * calls it in the renderer. It used to be pasted into both headers.
 */
export function roleLabel(role: Role | null | undefined, perms?: Perms): string | null {
  if (perms && !isLabelWideUser(perms) && perms.groupRoles.length > 0) {
    return perms.groupRoles.some((g) => g.role === "artist_manager") ? "Ar" : "สมาชิก";
  }
  return role ? ROLE_SHORT[role] : null;
}

/**
 * "role · where", the account panel's second line ("สมาชิก · Seishin Kakumei",
 * "Admin · A Lot Of Tone"). A band person is placed by their band(s); a label-wide
 * account by the label. Display only — an empty `groups` (a read that failed, see
 * the caller) just drops the band name; it never decides what anyone may open.
 */
export function accountLine({
  role,
  perms,
  groups,
  tenantName,
}: {
  role: Role | null | undefined;
  perms?: Perms;
  groups: { id: string; name: string }[];
  tenantName?: string | null;
}): string | null {
  const shown = roleLabel(role, perms);
  let where: string | null = tenantName ?? null;
  if (perms && !isLabelWideUser(perms) && perms.groupRoles.length > 0) {
    const mine = perms.groupRoles
      .map((r) => groups.find((g) => g.id === r.group_id)?.name)
      .filter((n): n is string => !!n);
    // Most band people are in one band; two or more would push the line off a
    // phone, so the first one plus a count is enough to say "this is you".
    where = mine.length === 0 ? null : mine.length === 1 ? mine[0] : `${mine[0]} +${mine.length - 1}`;
  }
  const parts = [shown, where].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : null;
}
