import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Sanitize a redirect target (e.g. a post-login `?next=`) to an INTERNAL path only.
 * Blocks external / protocol-relative (`//evil.com`) and backslash (`/\evil.com`)
 * forms that a browser resolves to ANOTHER origin → open-redirect / phishing.
 * Returns `fallback` for anything that isn't a plain in-app path.
 */
export function safeInternalPath(
  next: string | null | undefined,
  fallback = "/dashboard"
): string {
  if (!next || !next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
  // The URL parser drops tab / CR / LF anywhere in a URL, so "/\t/evil.com" passes
  // both checks above and still lands on //evil.com. No control character, ever.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  return next;
}
