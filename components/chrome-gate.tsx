"use client";

import { usePathname } from "next/navigation";

/**
 * The two screens that run a show: Live Mode and the festival's live show-caller.
 * They are immersive — the app header, the tab bar and the push nudge all step
 * aside, because every pixel and every stray tap on those screens belongs to the
 * show. `/events/[id]/run-order` (the builder) and `/events/[id]/practice` are NOT
 * immersive: they are ordinary pages with a back link.
 */
export function isImmersivePath(pathname: string | null | undefined): boolean {
  return /^\/events\/[^/]+\/(?:run-order\/)?live\/?$/.test(pathname ?? "");
}

/** Renders its children (the app chrome) everywhere except the immersive screens. */
export function ChromeGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return isImmersivePath(pathname) ? null : <>{children}</>;
}
