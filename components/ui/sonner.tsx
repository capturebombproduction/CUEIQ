"use client";

import { useSyncExternalStore } from "react";
import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

// The theme is a class on <html> (dark by default, light opt-in), not a media
// query, so sonner cannot see it by itself. Left alone it renders its LIGHT rich
// palette, and every saved/failed toast flashed a pastel card on the dark app.
function subscribeHtmlClass(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function htmlTheme(): "dark" | "light" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Under the sticky header (or Live's top bar), never on top of it. */
export const TOAST_OFFSET = "calc(var(--header-h) + env(safe-area-inset-top) + 8px)";

// Spec §E.10: a popover slab with a 4 px status rail and a tinted icon — never a
// coloured card. Two details carry the weight:
//  • sonner injects its stylesheet into <head> at runtime, AFTER ours, so equal
//    specificity loses to it. Its toast rules are (0,2,0) and its title /
//    description / button rules (0,3,0): the group-[.toaster] variants below are
//    (0,3,0) for the first, and the few (0,3,0) clashes take `!`.
//  • the rail is a CSS variable the type class sets, read by the ONE box-shadow on
//    the toast: two box-shadow utilities on one element would not add up, the
//    later one would simply replace the edge.
const RAIL =
  "group-[.toaster]:shadow-[inset_var(--toast-rail,0px)_0_0_hsl(var(--toast-rail-c,var(--border))),inset_0_0_0_1px_hsl(var(--border)),0_18px_40px_-16px_hsl(var(--shadow)/var(--shadow-a))]";

const Toaster = (props: ToasterProps) => {
  const theme = useSyncExternalStore(subscribeHtmlClass, htmlTheme, () => "dark" as const);
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      position="top-center"
      offset={TOAST_OFFSET}
      // Phones (<= 600 px) read a separate offset; without it the toast sits 16 px from
      // the top, over the header.
      mobileOffset={{ top: TOAST_OFFSET }}
      toastOptions={{
        classNames: {
          toast: `group toast group-[.toaster]:rounded-[3px] group-[.toaster]:border-0 group-[.toaster]:bg-popover group-[.toaster]:font-sans group-[.toaster]:text-popover-foreground ${RAIL}`,
          title: "group-[.toast]:text-[14px] group-[.toast]:!font-semibold",
          description: "group-[.toast]:text-[12.5px] group-[.toast]:!text-muted-foreground",
          actionButton:
            "group-[.toast]:!rounded-[2px] group-[.toast]:!bg-primary group-[.toast]:!text-primary-foreground",
          cancelButton:
            "group-[.toast]:!rounded-[2px] group-[.toast]:!bg-muted group-[.toast]:!text-muted-foreground",
          success: "[--toast-rail-c:var(--success)] [--toast-rail:4px] [&_[data-icon]]:text-success-ink",
          error: "[--toast-rail-c:var(--destructive)] [--toast-rail:4px] [&_[data-icon]]:text-destructive",
          warning: "[--toast-rail-c:var(--warning)] [--toast-rail:4px] [&_[data-icon]]:text-warning-ink",
          info: "[--toast-rail-c:var(--info)] [--toast-rail:4px] [&_[data-icon]]:text-info-ink",
        },
      }}
      {...props}
      // Rich colours are off whatever a caller passes (app/layout.tsx and the desktop
      // main.tsx still say `richColors`): they paint the whole card in a pastel that
      // ignores the theme tokens, which is exactly what the rail replaces.
      richColors={false}
    />
  );
};

export { Toaster };
