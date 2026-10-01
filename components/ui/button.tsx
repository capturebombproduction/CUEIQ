import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Spec §E.2. Labels are Kanit by default — most of the ~230 call sites are Thai. An
// ENGLISH label opts into display caps with `className="en"` on the Button, or by
// wrapping the word in <span className="en"> (app/stage.css: `.en`, `button .en`).
// A mixed label keeps the Thai plain: <Clock/> คาดจบ <span className="num">18:56</span>.
//
// Icon size: `:where(&) svg`, not shadcn's `[&_svg]:size-4`. That one compiles to
// `.x svg` (0,1,1), which out-ranks any `h-5 w-5` (0,1,0) a call site puts on its own
// icon — every explicitly sized icon in a Button rendered at 16 px regardless. Under
// :where() the default weighs (0,0,1): it still sizes a bare <Icon/> and loses to any
// class on the icon.
//
// The label face and weight are lowered the same way: as plain utilities,
// `font-sans font-semibold` (0,1,0, later in the sheet) beat `.en`, and an English
// Button rendered Kanit 600 in caps instead of Barlow 800. `html :where(&)` is
// (0,0,1): it still beats preflight's `button { font-weight: inherit }` (same weight,
// earlier in the sheet) — a bare :where(&) at (0,0,0) lost to it and every label
// went 400 — and loses to `.en`, the dock's `font-display` and any caller class.

/** The focus ring a chamfered (`.cut`) control needs: inset, two-tone, survives the clip. */
const CUT_FOCUS =
  "focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--background)),inset_0_0_0_4px_hsl(var(--foreground))]";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[3px] text-[15px] ring-offset-background [html_:where(&)]:font-sans [html_:where(&)]:font-semibold transition-[transform,background-color] duration-1 ease-out active:scale-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [:where(&)_svg]:size-[18px]",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/[.92]",
        // Solid red is reserved for the moment of no return: inside ConfirmDialog /
        // the type-to-confirm sheet. Everywhere else a delete is destructive-outline.
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        "destructive-outline":
          "border-[1.5px] border-dashed border-destructive bg-transparent text-foreground hover:bg-destructive/10 [&_svg]:text-destructive",
        // The 1.5px --input ring is the same >= 3:1 boundary a field gets (lib/skin.ts).
        outline: "bg-transparent shadow-[inset_0_0_0_1.5px_hsl(var(--input))] hover:bg-muted",
        secondary: "bg-muted text-foreground shadow-edge hover:bg-muted/80",
        ghost: "hover:bg-muted",
        link: "text-primary-ink underline-offset-4 hover:underline",
        success: "bg-success text-success-foreground hover:bg-success/90",
        // Live dock keys (PREV / PAUSE / RUN, the run-order ±min push). Size lives in
        // compoundVariants below so it beats `size`; labels are English chrome.
        dock: "flex-col gap-1 bg-muted text-foreground shadow-edge font-display text-[12px] font-extrabold uppercase tracking-[.14em] [font-synthesis:none] [:where(&)_svg]:size-[22px] stage:text-[13px] stage:[:where(&)_svg]:size-[26px]",
        // The chamfered NEXT / START key. Its label is the call site's:
        //   <span className="font-display-x text-[32px] font-extrabold uppercase italic leading-[.82] tracking-[.03em] stage:text-[36px]">Next</span>
        //   + a 12.5 px Kanit subtitle. A clip-path cuts the outer focus ring off, and a
        //   primary ring vanishes on a primary fill — so it gets the inset two-tone ring.
        next: `${CUT_FOCUS} cut justify-between bg-primary text-primary-foreground hover:bg-primary/[.92] [--cut:12px] stage:[--cut:16px] [:where(&)_svg]:size-7`,
      },
      size: {
        default: "h-11 px-4",
        sm: "h-9 px-3 text-[13px]",
        lg: "h-12 px-5",
        xl: "h-14 px-7 text-base",
        icon: "h-11 w-11",
      },
    },
    // compoundVariants render AFTER `size`, so these dimensions win over the default
    // size's h-11 instead of being merged away by it.
    compoundVariants: [
      { variant: "dock", class: "h-16 w-16 shrink-0 px-0 stage:h-[72px] stage:w-[100px]" },
      { variant: "next", class: "h-16 px-5 stage:h-[72px] stage:px-7" },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

const isChamfered = (variant: ButtonProps["variant"], className?: string) =>
  variant === "next" || /(^|\s)cut(\s|$)/.test(className ?? "");

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(
          buttonVariants({ variant, size }),
          // Training's play key or any other `.cut` Button gets the same inset ring.
          isChamfered(variant, className) && CUT_FOCUS,
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants, CUT_FOCUS };
