import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { hasThai } from "@/lib/thai";

/**
 * A page's H1 (spec §E.11): display-x 800 italic caps, 56 px, with an optional right
 * slot (a count, a filter, an action) bottom-aligned to it.
 *
 * Page titles are English by house rule; a Thai one still renders sanely — upright
 * Kanit at a size its tone marks fit — rather than squeezed into a .84 line-height.
 *
 * Nothing is drawn behind the title (v3 dropped v2's outlined ghost word): the page
 * light is the only thing there. The page's `main` keeps `overflow-x-clip` — never
 * overflow-hidden, which breaks the sticky header and tabs.
 */
export function PageTitle({
  title,
  right,
  className,
}: {
  title: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("page-title", className)}>
      <h1
        className={cn(
          "min-w-0",
          hasThai(title) ? "text-3xl font-bold leading-tight" : "h1"
        )}
      >
        {title}
      </h1>
      {right != null && right !== false && (
        <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div>
      )}
    </div>
  );
}
