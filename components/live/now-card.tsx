"use client";

import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { Hourglass, Lightbulb, OctagonAlert, SkipForward, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { thresholds, zoneCaption, type LiveZone } from "@/lib/live-zone";
import { formatDuration, isSettled } from "@/lib/time";
import { Countdown } from "@/components/live/countdown";
import { KindChip } from "@/components/event/kind";
import type { SetlistKind } from "@/lib/types";

const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * The NOW title steps down with its length (CQ-11): one line, so a long title was cut
 * ("[SYSTEM_BOOT] SE (Overture)" lost its "(Overture)" on a phone). Three sizes - the card's
 * own 26 / 40 px (stage), then 22 / 32 and 19 / 28 - picked by how many glyphs the title has.
 * The thresholds are what Barlow Condensed 800 gets into the title column (about 250 px on a
 * 390 phone, about 370 px on the stage layout at 1180); tune them from a measurement, not by
 * feel. Thai tone marks and lower vowels sit on a base glyph and take no width: not counted.
 *
 * THE LINE BOX IS THE SAME PX AT EVERY STEP (26 x 1.04 = 27.04, 40 x 1.04 = 41.6). The title
 * row is as tall as its h2, and this card is ONE height in every zone (the NEXT card's mic
 * grid must never slide under the dock): a smaller font on the card's `1.04` line-height
 * would shrink the row by 3-10 px, so the smaller steps pin the line-height in px instead.
 */
const TITLE_STEP_MAX_GLYPHS = [17, 22] as const;
const TITLE_SIZE = [
  "text-[26px] leading-[1.04] stage:text-[40px]",
  "text-[22px] leading-[27.04px] stage:text-[32px] stage:leading-[41.6px]",
  "text-[19px] leading-[27.04px] stage:text-[28px] stage:leading-[41.6px]",
] as const;
function titleStep(title: string): 0 | 1 | 2 {
  const glyphs = Array.from(title.replace(/\p{Mn}/gu, "")).length;
  return glyphs <= TITLE_STEP_MAX_GLYPHS[0] ? 0 : glyphs <= TITLE_STEP_MAX_GLYPHS[1] ? 1 : 2;
}

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
  // The cue note opens in full on a tap — a `title` tooltip never opens on a phone or
  // an iPad. Open for THIS item's note only: when the show moves on, it is closed.
  const noteKey = note ? `${index}\u0000${note}` : null;
  const [openNote, setOpenNote] = useState<string | null>(null);
  const noteOpen = !over && noteKey !== null && openNote === noteKey;
  const noteId = useId();
  return (
    <section
      data-zone={zone}
      className={cn(
        // Landscape phone (390 px tall): a half-width item of Live's wrapping row,
        // and the tight version of the card — 32 px header, no note row, no fade row
        // (Live tools carries the fades there), smaller gaps — so its bottom clears
        // the dock by 8 px with the iPhone's 21 px home-indicator inset too.
        "now flex flex-col pb-3.5 stage:min-h-0 stage:![--pad:24px] [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:![--pad:18px] [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:min-w-0 [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:basis-[calc(50%-6px)] [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:pb-2.5",
        // Overtime breaks the chamfer AND the phone's 16 px gutter: a square plate to
        // the screen edges is the one shape nothing else on the screen has.
        over
          ? "alarm-plate -mx-4 stage:mx-0 [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:mx-0"
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
          className="zhead hazard-band stage:h-[46px] [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:h-8"
        >
          <span>
            <OctagonAlert aria-hidden />
            Overtime · <span className="th text-[14px] font-bold">เกินเวลา</span>
          </span>
        </div>
      ) : (
        <div key="zone" className="zhead stage:h-[46px] [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:h-8">
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
          {/* Landscape phone, WARN / URGENT: the strip (32 px, in a half-width card) has no room for
              the index beside a tag, a threshold and the clock, so the title row carries it instead
              (as it does in overtime) and the strip drops it. Never for OK, whose strip fits. */}
          <span
            className={cn(
              "num zidx text-[16px]",
              zone !== "ok" && "[@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:hidden"
            )}
          >
            {pos}
          </span>
          <span className="zend">
            จบ<b suppressHydrationWarning>{endClock}</b>
          </span>
        </div>
      )}

      <div className="mt-1.5 flex min-w-0 items-center gap-2 [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:mt-1">
        {/* py + matching -my: the clip (overflow: hidden) is the padding box, and at
            1.04 a Barlow-first line box ends inside Kanit's stacked tone marks and
            ุ / ู. The padding gives them room; the margin keeps the row's height. */}
        <h2 className={cn("disp min-w-0 flex-1 truncate py-[.25em] -my-[.25em]", TITLE_SIZE[titleStep(title)])}>{title}</h2>
        {zone !== "ok" && (
          <span className={cn("num shrink-0 text-[16px]", !over && "hidden [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:inline")}>{pos}</span>
        )}
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
          Not on a landscape phone (no room; the zone caption below still speaks). A tap
          lays the whole note OVER the card, so its height never changes; Live tools
          carries the full note too (a phone held sideways, overtime). */}
      <div
        className={cn(
          "relative mt-0.5 flex h-5 min-w-0 items-center gap-1.5 text-[13px] [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:hidden",
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
            <button
              type="button"
              aria-expanded={noteOpen}
              aria-controls={noteId}
              title={note}
              onClick={() => setOpenNote(noteOpen ? null : noteKey)}
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              <Lightbulb aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{note}</span>
            </button>
            {noteOpen && (
              <p
                id={noteId}
                className="absolute inset-x-0 top-full z-10 mt-1 max-h-40 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-[2px] bg-popover px-3 py-2 text-[13px] leading-snug text-popover-foreground shadow-elev-2"
              >
                {note}
              </p>
            )}
          </>
        ) : null}
      </div>

      {/* Phone: the countdown's own fixed height (max × .8). Stage: it fills what the
          column leaves and is fitted to BOTH the width (cqi) and that height (cqb), so
          a resume / fault / sync banner can shrink the numerals but never push the
          fade row out of the card. Landscape phone: the 120 px cap in a 96 px box.
          The cq override is gated `supports-[width:1cqi]`: written bare, a browser without
          container-query units (Safari < 16) drops it at computed-value time and the numerals
          fall to the inherited ~16 px. There app/stage.css sizes `.cd` from two custom
          properties this wrapper sets in the viewport's units (set on every layout, read
          only by that fallback; app/stage-css.test.tsx holds them to what a browser measured):
            --cd-col  the column. Phone: the page less its gutters and the card's padding, capped
                      at the 672 px page. Landscape phone: half the viewport less the gutters,
                      the gap and the padding. Stage: the viewport less 740 px (gutters, the other
                      two columns, the padding), and 20 px of slack.
            --cd-h    the box's height, stage only. The box is 100vh - 536 px (fade keys and the
                      volume row in the card), 164 px at the stage's 700 px floor, and the
                      digits are .8 of the font size (189 px at the 236 px cap): a width-only fit
                      overlapped the fade row on a short stage. 64 px of slack more, for the iOS
                      volume note or a banner, which this box then loses.
          Both size a little under what the cq fit gives, never over. */}
      <div className="mt-2 [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:mt-1 stage:mt-1 stage:grid stage:min-h-0 stage:flex-1 stage:[&_.cd-wrap]:!h-auto stage:[&_.cd-wrap]:[container-type:size] stage:[&_.cd]:![--cd-max:236px] stage:supports-[width:1cqi]:[&_.cd]:![font-size:min(var(--cd-max),calc(100cqi/var(--cd-em,1.84)),calc(100cqb/0.8))] [--cd-col:min(80vw,100vw_-_72px,600px)] [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:[--cd-col:calc(50vw_-_68px)] stage:[--cd-col:calc(100vw_-_760px)] stage:[--cd-h:calc(100vh_-_600px)] [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:[&_.cd-wrap]:!h-[96px] [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:[&_.cd]:![--cd-max:120px]">
        <Countdown seconds={Math.round(remaining)} max={164} />
      </div>

      {over ? (
        <div className="mt-3 h-2 shrink-0 hatch [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:mt-2 stage:h-2.5" />
      ) : (
        <div
          className={cn(
            "track zoned mt-3 shrink-0 [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:mt-2 stage:h-2.5",
            zone === "warn" && "warn",
            zone === "urgent" && "urgent"
          )}
          style={{ "--wz": pct(blockSec - t.warn), "--uz": pct(blockSec - t.urgent) } as CSSProperties}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      )}

      <div className="mt-2 flex shrink-0 items-baseline justify-between gap-2 text-[11.5px] text-muted-foreground [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:mt-1.5 stage:text-[12.5px]">
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
        <div className="mt-2.5 [@media(orientation:landscape)_and_(max-height:699.98px)_and_(pointer:coarse)]:hidden stage:shrink-0">{children}</div>
      )}
    </section>
  );
}
