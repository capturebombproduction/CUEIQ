import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Field look shared by Input, Textarea and the Select trigger (spec §E.7): a card
 * fill and a 1.5 px INSET --input boundary (>= 3:1 against card and page for every
 * band — lib/skin.ts walks it), thickening to 2 px --ring on focus. Inset, not a
 * border, so focus does not shift the text by a pixel.
 */
export const FIELD =
  "rounded-[3px] bg-card shadow-[inset_0_0_0_1.5px_hsl(var(--input))] placeholder:text-faint focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_hsl(var(--ring))] aria-[invalid=true]:shadow-[inset_0_0_0_2px_hsl(var(--destructive))] disabled:cursor-not-allowed disabled:opacity-50";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // text-base on phones is not a type-scale choice: iOS Safari zooms the
          // whole page in when a focused field is under 16px and never zooms back,
          // so every tap into a form left the user stranded mid-page, panning to
          // find the next field. 14px returns from sm: up, where no engine zooms.
          "flex h-11 w-full px-3.5 py-2 text-base sm:text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium",
          FIELD,
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
