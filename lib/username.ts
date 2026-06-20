/**
 * CueIQ runs on Supabase Auth, which only authenticates by email (or phone). To
 * let label members sign in with a plain username — many band members don't have,
 * or don't want to expose, a real inbox — we wrap a bare username into a synthetic
 * internal email under this domain. Accounts are created with email_confirm: true,
 * so nothing is ever actually mailed to these addresses.
 *
 * A login id may be EITHER a bare username ("ar01") or a real email
 * ("nutthapat@gmail.com"). Real emails are passed through untouched, so existing
 * email accounts keep working exactly as before.
 */
export const INTERNAL_EMAIL_DOMAIN = "cueiq.local";

/** Bare username: lowercase letters, digits, dot, underscore, hyphen. */
const USERNAME_RE = /^[a-z0-9._-]+$/;
const EMAIL_RE = /^.+@.+\..+$/;

/** True if `input` is a usable login id (a bare username or a full email). */
export function isValidLoginId(input: string): boolean {
  const v = input.trim().toLowerCase();
  if (!v) return false;
  return v.includes("@") ? EMAIL_RE.test(v) : USERNAME_RE.test(v);
}

/** Convert a login id into the email GoTrue actually authenticates against. */
export function loginIdToEmail(input: string): string {
  const v = input.trim().toLowerCase();
  return v.includes("@") ? v : `${v}@${INTERNAL_EMAIL_DOMAIN}`;
}

/** Strip the synthetic domain back off for display (real emails shown as-is). */
export function displayLoginId(email: string | null | undefined): string {
  if (!email) return "";
  const suffix = `@${INTERNAL_EMAIL_DOMAIN}`;
  return email.endsWith(suffix) ? email.slice(0, -suffix.length) : email;
}
