"use client";

import { ErrorCard } from "@/components/error-card";

/**
 * Error boundary for the whole in-app area. Without it a render error (e.g. a
 * Safari-only throw) silently blanks the page under the nav — impossible to debug
 * from a phone. This catches it, shows what can be said, and logs the cause so it
 * is visible instead of a mystery blank.
 *
 * It does NOT catch a throw from `app/(app)/layout.tsx` beside it — Next never lets
 * an error.tsx catch its own segment's layout. That one goes to `app/error.tsx`,
 * which is why both exist and why they share one body (components/error-card.tsx).
 */
export default function AppError({ error }: { error: Error & { digest?: string } }) {
  // `reset` is deliberately not taken: see the long note in ErrorCard about why the
  // card offers a reload and not Next's reset().
  return <ErrorCard error={error} where="in-app" />;
}
