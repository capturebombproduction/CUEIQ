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
  return next;
}
