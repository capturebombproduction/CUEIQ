import type { CSSProperties, ReactNode } from "react";
import { Hourglass, Lightbulb, OctagonAlert, SkipForward, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { thresholds, zoneCaption, type LiveZone } from "@/lib/live-zone";
import { formatDuration, isSettled } from "@/lib/time";
import { Countdown } from "@/components/live/countdown";
import { KindChip } from "@/components/event/kind";
import type { SetlistKind } from "@/lib/types";

const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * Live Mode's NOW card (FINAL-SPEC-v2 §G.10): ONE shape for all four zones, so the
 * card is the same height in every one of them and the NEXT card's mic grid can
 * never slide under the dock when the ladder steps.
 *
 *   ok      `lit cut`: the band key edge, a NOW tag
 *   warn    the frame step: amber key + side rails, a WARN tag naming the threshold
 *   urgent  the fill step: a low-luminance amber wash, the striped plate slammed in once
 *   over    the inversion: the alarm plate (full-bleed on a phone) under a hazard band;
 *           ten seconds past zero it settles into a framed card, hazard band kept
 *
 * The colours live in app/stage.css (.zone-warn / .zone-urgent / .alarm-plate), on
 * tokens no band skin writes — this file only names the classes. Presentation only:
 * every number arrives as a prop; nothing here reads a clock or touches audio.
 */
export function NowCard({
  zone,
  blockSec,
  remaining,
  elapsed,
  index,
  total,
  kind,
  title,
  note,
  endClock,
  canAdvance,
  children,
}: {
  zone: LiveZone;
  /** the item's whole block, buffers included — what the countdown counts down from */
  blockSec: number;
  remaining: number;
  elapsed: number;
  /** 1-based position of the item */
  index: number;
  total: number;
  /** null for an offline cached row that lost its kind: no chip, never a crash */
  kind: SetlistKind | null;
  title: string;
  note: string | null;
  /** wall-clock time the item ends, "HH:MM:SS" */
  endClock: string;
  /** may THIS device press NEXT now? Only then does overtime say "กด NEXT เมื่อพร้อม" */
  canAdvance: boolean;
  /** the fade row (and the stage volume row) */
  children?: ReactNode;
}) {
  const t = thresholds(blockSec);
  const over = zone === "over";
  const pct = (s: number) => (blockSec > 0 ? `${(s / blockSec) * 100}%` : "100%");
  const progress = blockSec > 0 ? Math.min(100, Math.max(0, (elapsed / blockSec) * 100)) : 0;
  const pos = `${p2(index)} / ${p2(total)}`;
  return (
    <section
      data-zone={zone}
      className={cn(
        // Landscape phone (390 px tall): a half-width item of Live's wrapping row,
        // and the tight version of the card — 32 px header, no note row, no fade row
        // (Live tools carries the fades there), smaller gaps — so its bottom clears
        // the dock by 8 px with the iPhone's 21 px home-indicator inset too.
        "now flex flex-col pb-3.5 stage:min-h-0 stage:![--pad:24px] [@media(orientation:landscape)_and_(max-height:699.98px)]:![--pad:18px] [@media(orientation:landscape)_and_(max-height:699.98px)]:min-w-0 [@media(orientation:landscape)_and_(max-height:699.98px)]:basis-[calc(50%-6px)] [@media(orientation:landscape)_and_(max-height:699.98px)]:pb-2.5",
        // Overtime breaks the chamfer AND the phone's 16 px gutter: a square plate to
        // the screen edges is the one shape nothing else on the screen has.
        over
          ? "alarm-plate -mx-4 stage:mx-0 [@media(orientation:landscape)_and_(max-height:699.98px)]:mx-0"
          : "lit cut [--cut:18px] stage:[--cut:26px]",
        zone === "warn" && "zone-warn",
        zone === "urgent" && "zone-urgent",
        over && isSettled(remaining) && "settled"
      )}
    >
      {/* Keyed apart: the overtime header is a NEW node, so role="alert" is announced
          when it appears (a role added to a reused node is not reliably read out). */}
      {over ? (
        <div
          key="over"
          role="alert"
          className="zhead hazard-band stage:h-[46px] [@media(orientation:landscape)_and_(max-height:699.98px)]:h-8"
        >
          <span>
            <OctagonAlert aria-hidden />
            Overtime · <span className="th text-[14px] font-bold">เกินเวลา</span>
          </span>
        </div>
      ) : (
        <div key="zone" className="zhead stage:h-[46px] [@media(orientation:landscape)_and_(max-height:699.98px)]:h-8">
          {zone === "ok" && <span className="ztag">Now</span>}
          {zone === "warn" && (
            <>
              <span className="ztag">
                <Hourglass aria-hidden />
                Warn
              </span>
              <span className="zthr text-[18px]">≤{formatDuration(t.warn)}</span>
            </>
          )}
          {zone === "urgent" && (
            <>
              <span className="ztag">
                <Timer aria-hidden />
                Urgent
              </span>
              <span className="zthr text-[20px]">≤{formatDuration(t.urgent)}</span>
            </>
          )}
          <span className="num zidx text-[16px]">{pos}</span>
          <span className="zend">
            จบ<b suppressHydrationWarning>{endClock}</b>
          </span>
        </div>
      )}

      <div className="mt-1.5 flex min-w-0 items-center gap-2 [@media(orientation:landscape)_and_(max-height:699.98px)]:mt-1">
        <h2 className="disp min-w-0 flex-1 truncate text-[26px] leading-[1.04] stage:text-[40px]">{title}</h2>
        {over && <span className="num shrink-0 text-[16px]">{pos}</span>}
        {kind && (
          <KindChip
            kind={kind}
            className={cn(
              "shrink-0",
              // on the plate a solid band chip would put band colour on the alarm
              over && "!bg-transparent !text-current shadow-[inset_0_0_0_1.5px_currentColor]"
            )}
          />
        )}
      </div>

      {/* One line, fixed height in every zone: the cue note, or overtime's instruction.
          Not on a landscape phone (no room; the zone caption below still speaks). */}
      <div
        className={cn(
          "mt-0.5 flex h-5 min-w-0 items-center gap-1.5 text-[13px] [@media(orientation:landscape)_and_(max-height:699.98px)]:hidden",
          over ? "font-semibold" : "text-muted-foreground"
        )}
      >
        {over ? (
          <>
            <SkipForward aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">
              {canAdvance ? "กด NEXT เมื่อพร้อม · " : ""}วางไว้{" "}
              <span className="num text-[15px]">{formatDuration(blockSec)}</span>
            </span>
          </>
        ) : note ? (
          <>
            <Lightbulb aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate" title={note}>
              {note}
            </span>
          </>
        ) : null}
      </div>

      {/* Phone: the countdown's own fixed height (max × .8). Stage: it fills what the
          column leaves and is fitted to BOTH the width (cqi) and that height (cqb), so
          a resume / fault / sync banner can shrink the numerals but never push the
          fade row out of the card. Landscape phone: the 120 px cap in a 96 px box. */}
      <div className="mt-2 [@media(orientation:landscape)_and_(max-height:699.98px)]:mt-1 stage:mt-1 stage:grid stage:min-h-0 stage:flex-1 stage:[&_.cd-wrap]:!h-auto stage:[&_.cd-wrap]:[container-type:size] stage:[&_.cd]:![--cd-max:236px] stage:[&_.cd]:![font-size:min(var(--cd-max),calc(100cqi/var(--cd-em,1.84)),calc(100cqb/0.8))] [@media(orientation:landscape)_and_(max-height:699.98px)]:[&_.cd-wrap]:!h-[96px] [@media(orientation:landscape)_and_(max-height:699.98px)]:[&_.cd]:![--cd-max:120px]">
        <Countdown seconds={Math.round(remaining)} max={164} />
      </div>

      {over ? (
        <div className="mt-3 h-2 shrink-0 hatch [@media(orientation:landscape)_and_(max-height:699.98px)]:mt-2 stage:h-2.5" />
      ) : (
        <div
          className={cn(
            "track zoned mt-3 shrink-0 [@media(orientation:landscape)_and_(max-height:699.98px)]:mt-2 stage:h-2.5",
            zone === "warn" && "warn",
            zone === "urgent" && "urgent"
          )}
          style={{ "--wz": pct(blockSec - t.warn), "--uz": pct(blockSec - t.urgent) } as CSSProperties}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      )}

      <div className="mt-2 flex shrink-0 items-baseline justify-between gap-2 text-[11.5px] text-muted-foreground [@media(orientation:landscape)_and_(max-height:699.98px)]:mt-1.5 stage:text-[12.5px]">
        <span className="num text-[14px] text-foreground stage:text-[16px]">{formatDuration(elapsed)}</span>
        <span
          className={cn(
            "min-w-0 truncate",
            (zone === "warn" || zone === "urgent") && "font-semibold text-warning-ink",
            over && "font-semibold"
          )}
        >
          {zoneCaption(zone, blockSec)}
        </span>
        <span className="num text-[14px] stage:text-[16px]">{formatDuration(blockSec)}</span>
      </div>

      {children && (
        <div className="mt-2.5 [@media(orientation:landscape)_and_(max-height:699.98px)]:hidden stage:shrink-0">{children}</div>
      )}
    </section>
  );
}
