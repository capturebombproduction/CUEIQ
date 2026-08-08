"use client";

import { ErrorCard } from "@/components/error-card";

/**
 * The ROOT error boundary, and round 11 is why it exists.
 *
 * `getWorkspace()` used to discard the `.error` on all four of its reads, so a
 * statement timeout on tenant_members came back as "this user is in no band" — a
 * real label member got the join screen, and both run-order routes silently
 * redirected to /dashboard. It now throws instead, on the reasoning that a page the
 * user can retry beats a confident wrong answer about their own permissions.
 *
 * But it is called from `app/(app)/layout.tsx`, and Next never lets an error.tsx
 * catch a throw from the layout.tsx BESIDE it. So that throw sailed past
 * `app/(app)/error.tsx` to `app/global-error.tsx`, which replaces the root layout
 * wholesale and can only say "เกิดข้อผิดพลาด" — no fonts, no theme, and crucially no
 * way to tell the operator the one thing they need to hear: nothing was lost.
 *
 * This boundary sits above `(app)` and below the root layout, so it catches that
 * throw and renders the same card the in-app boundary does, inside the real layout.
 * global-error remains for what nothing else can catch: a throw in the root layout
 * itself.
 */
export default function RootError({ error }: { error: Error & { digest?: string } }) {
  // `reset` is deliberately not taken: see the long note in ErrorCard about why the
  // card offers a reload and not Next's reset().
  return <ErrorCard error={error} where="root" />;
}
