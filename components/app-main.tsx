"use client";

import { usePathname } from "next/navigation";
import { isImmersivePath } from "@/components/chrome-gate";

/** What <main> keeps on the immersive screens: a stacking box and nothing else. */
export const IMMERSIVE_MAIN_CLASS = "relative z-[1] overflow-x-clip";

/**
 * The app's <main>. The (app) layout is a server component and cannot read the
 * path, so the one thing about <main> that depends on it lives here.
 *
 * On the two screens that run a show (Live Mode, the live show-caller — see
 * chrome-gate.tsx) <main> drops the container, its padding and the tab-bar
 * clearance: those screens are edge to edge, own their own gutter, and at stage
 * size are exactly one screen tall. With the ordinary page padding left on, the
 * gutter doubled to 32 px, the overtime plate stopped 16 px short of the screen
 * edge, the top bar sat 20 px down and the stage layout scrolled.
 */
export function AppMain({ className, children }: { className: string; children: React.ReactNode }) {
  const pathname = usePathname();
  return <main className={isImmersivePath(pathname) ? IMMERSIVE_MAIN_CLASS : className}>{children}</main>;
}
