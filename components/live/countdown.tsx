import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { formatCountdown, formatOvertime } from "@/lib/time";

/**
 * The Live countdown (spec §E.9): Barlow 800 tabular numerals, FITTED to its column
 * by container query (app/stage.css `.cd`: min(--cd-max, column / --cd-em), where
 * --cd-em is picked per string length through data-len), so "1:00:00" never spills
 * out of a 300 px landscape-phone column.
 *
 * `fixed` reserves max × .8 (the .cd line-height) whatever the text, so a shorter
 * "+0:24" — which fits at a smaller size — can't shrink the NOW card and let the NEXT
 * card's mic grid slide up under the dock between zones. One height in every zone.
 *
 * Never italic, never glowing, and never "88:88" ghost digits behind it: at arm's
 * length the 8 behind a thin 1 turned 2:21 into 2:28. One text layer, nothing else.
 */
export function Countdown({
  seconds,
  max = 164,
  fixed = true,
  className,
}: {
  /** remaining seconds; below zero renders as overtime "+m:ss" */
  seconds: number;
  /** the size cap in px: 164 phone NOW, 236 stage NOW, 120 landscape phone */
  max?: number;
  fixed?: boolean;
  className?: string;
}) {
  const over = seconds < 0;
  const text = over ? formatOvertime(seconds) : formatCountdown(seconds);
  return (
    <div
      className="cd-wrap grid place-items-center"
      style={fixed ? { height: Math.round(max * 0.8) } : undefined}
    >
      {/* suppressHydrationWarning: the server renders a second earlier than the client. */}
      <div
        role="timer"
        className={cn("cd w-full", className)}
        data-len={text.length}
        style={{ "--cd-max": `${max}px` } as CSSProperties}
        suppressHydrationWarning
      >
        {/* The "+" is set smaller so the digits keep the full size the column allows. */}
        {over ? (
          <>
            <span className="plus">+</span>
            {text.slice(1)}
          </>
        ) : (
          text
        )}
      </div>
    </div>
  );
}
