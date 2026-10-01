import * as React from "react";

import { cn } from "@/lib/utils";
import { FIELD } from "@/components/ui/input";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          // 16px on phones or iOS zooms the page in on focus and never back out
          // (see components/ui/input.tsx). `/relaxed` rides on the size utility: a
          // separate leading-relaxed would lose to sm:text-sm's own line-height.
          "flex min-h-[96px] w-full px-3.5 py-2.5 text-base/relaxed sm:text-sm/relaxed",
          FIELD,
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
