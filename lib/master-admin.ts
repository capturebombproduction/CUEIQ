/**
 * The "Master Admin" account is protected at the code level: it can never be
 * deleted, and its role / permissions can't be changed by anyone other than
 * itself — not even by other tenant admins.
 *
 * Protection lives in CODE (not a DB flag) on purpose: a DB flag could be
 * cleared by another admin or a stray service-role write, but a hardcoded guard
 * can only be lifted by shipping a new build. The account is identified by its
 * (synthetic) email — bare usernames map to <name>@cueiq.local via lib/username.
 */
export const MASTER_ADMIN_EMAILS = ["architect@cueiq.local"];

export function isMasterAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return MASTER_ADMIN_EMAILS.includes(email.trim().toLowerCase());
}
