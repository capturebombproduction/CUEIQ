"use client";

import { usePathname } from "next/navigation";
// For its side effect: install-button captures `beforeinstallprompt` at module scope.
// This gate unmounts the header (and the install button in it) on the immersive
// screens, and is itself mounted on every (app) page — so loading it here means the
// event is caught even by a document that opens on Live, and outlives the header.
import "@/components/install-button";

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

/** The event id of an immersive screen, else null. The error cards use it for their
 *  way out ("กลับไปหน้างาน"): with the header and tab bar gone, a card that can only
 *  reload is a dead end on exactly these two screens. */
export function immersiveEventId(pathname: string | null | undefined): string | null {
  const m = /^\/events\/([^/]+)\/(?:run-order\/)?live\/?$/.exec(pathname ?? "");
  return m ? m[1] : null;
}

/** Renders its children (the app chrome) everywhere except the immersive screens. */
export function ChromeGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return isImmersivePath(pathname) ? null : <>{children}</>;
}
