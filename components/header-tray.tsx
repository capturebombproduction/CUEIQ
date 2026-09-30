"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { MoreHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The header's seldom-used tools (fullscreen, band colour, theme, password,
 * sign out) behind one "⋯" on a phone; inline, as before, from sm up.
 *
 * Measured 2026-10-01 at 390px: the sticky header was four rows and 167px —
 * a fifth of the screen on every page, for good — and a whole row of it was
 * these five icons. Behind "⋯" the header is two rows. The bell and the
 * install button stay OUT of here on purpose: the bell is how feedback replies
 * and show reminders are seen, and installing is the step push needs on an
 * iPhone (push reaches 1 of 19 accounts; hiding either would cost that).
 *
 * Rendered once and hidden with CSS rather than mounted per breakpoint: these
 * children own dialogs and listeners (password dialog, fullscreen state), and a
 * second copy would double them.
 */
export function HeaderTray({
  identity,
  children,
}: {
  /** Role + name — shown inside the tray on a phone (the top row has no room). */
  identity?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="header-tray"
        aria-label={open ? "ปิดเมนู" : "เมนูเพิ่มเติม"}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted sm:hidden"
      >
        {open ? <X className="h-5 w-5" /> : <MoreHorizontal className="h-5 w-5" />}
      </button>
      <div
        id="header-tray"
        data-testid="header-tray"
        className={cn(
          open ? "flex" : "hidden",
          // nowrap: the five icons stay on one line and a long name truncates,
          // rather than "ออกจากระบบ" dropping to a row of its own.
          "order-last w-full flex-nowrap items-center justify-end gap-x-1",
          "sm:order-none sm:flex sm:w-auto sm:gap-x-3"
        )}
      >
        {identity && (
          <div className="mr-auto flex min-w-0 flex-1 items-center gap-2 text-xs sm:hidden">
            {identity}
          </div>
        )}
        {children}
      </div>
    </>
  );
}
