import * as React from "react";

import { cn } from "@/lib/utils";
import { hasThai } from "@/lib/thai";

// Spec §E.3. Surface levels: L0 page (bg-background) · L1 Card, a "slab" · L2 "well"
// (tiles, tracks, segmented) · L3 popover (sheets, dialogs, menus, toasts).
const CARD_VARIANTS = {
  // A slab: near-square, its edge an inset 1px border-colour line (no `border`, so a
  // call site's `border-l-4` band rail still draws on its own).
  default: "bg-card shadow-edge",
  // The ONE lit hero per screen: band key-line, chamfer, the sweep once on mount
  // (app/stage.css .lit / .cut / .sweep). No shadow utility here — a utility's
  // box-shadow would out-rank .lit's and erase the key-line it draws.
  hero: "lit cut sweep [--cut:16px]",
  well: "bg-muted",
} as const;

export type CardVariant = keyof typeof CARD_VARIANTS;

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { variant?: CardVariant }
>(({ className, variant = "default", ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      // --card-pad: the header/content/footer padding, set ONCE here so a call site's
      // own `py-16` / `p-3` on CardContent still wins at every width. Written as
      // `p-4 sm:p-5` on each part instead, a call site's unprefixed padding would lose
      // to the sm: one from 640 px up — every desktop empty state would collapse.
      "rounded-[2px] text-card-foreground [--card-pad:1rem] sm:[--card-pad:1.25rem]",
      CARD_VARIANTS[variant],
      className
    )}
    {...props}
  />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-[var(--card-pad,1rem)]", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

/**
 * English titles are display caps; a Thai title stays Kanit, sentence case, no
 * tracking — detected from the text itself, so the many Thai titles already written
 * need no `th` class (and `.th` alone could not undo these utilities anyway: a
 * utility out-ranks every stage.css class).
 */
const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      hasThai(children) || /(^|\s)th(\s|$)/.test(className ?? "")
        ? "font-sans text-[17px] font-semibold leading-snug"
        : "font-display text-[18px] font-extrabold uppercase leading-tight tracking-[.04em] [font-synthesis:none]",
      className
    )}
    {...props}
  >
    {children}
  </div>
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("px-[var(--card-pad,1rem)] pb-[var(--card-pad,1rem)]", className)}
    {...props}
  />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex items-center px-[var(--card-pad,1rem)] pb-[var(--card-pad,1rem)]",
      className
    )}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
};
