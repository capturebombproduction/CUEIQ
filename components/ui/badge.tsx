import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Spec §E.4: a Badge is a chip (app/stage.css `.chip*`): square, 24 px, Kanit 12.5 by
// default. A status is ALWAYS icon + word, never colour alone — put the icon inside
// (`.chip svg` sizes it) and add `en` when the word is English (display caps).
// A tappable chip adds `chip-lg` (44 px).
const badgeVariants = cva("chip transition-colors focus:outline-none", {
  variants: {
    variant: {
      default: "chip-primary",
      secondary: "chip-neutral",
      success: "chip-success",
      warning: "chip-warning",
      info: "chip-info",
      destructive: "chip-danger",
      // Overtime / overdue: the band-independent alarm plate.
      alarm: "chip-alarm",
      // chip-neutral without the fill: an edge only.
      outline: "text-muted-foreground shadow-edge",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
