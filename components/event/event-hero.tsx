import Link from "next/link";
import { ChevronRight, Headphones, MapPin, Radio } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { TitleSlab } from "@/components/title-slab";
import { DeadlineChip } from "@/components/event/deadline-chip";
import { dateParts } from "@/components/event/date-parts";
import { EVENT_TYPES, type EventType, type GroupStatus } from "@/lib/types";
import { shortClock } from "@/lib/time";
import { cn } from "@/lib/utils";

/** What the hero reads off a show. Everything optional but the id and name: the
 *  desktop renders this from a cached bundle, and a cached row can lack any field. */
export interface EventHeroEvent {
  id: string;
  name: string;
  venue?: string | null;
  map_url?: string | null;
  event_date?: string | null;
  show_start_time?: string | null;
  hard_out_time?: string | null;
  status?: string | null;
  deadline?: string | null;
  deadline_note?: string | null;
  event_type?: string | null;
  group?: { name?: string | null; color?: string | null; exempt_from_deadline?: boolean | null } | null;
}

/**
 * The show page's one lit surface (spec §G.3): band + type + status, the name as
 * a poster, the venue, then the four numbers a member opens a show for — the day,
 * the call, the stage and the hard out — and ONE row of actions.
 *
 * That row replaced four: the header's Export / Edit / resubmit / approve, and the
 * workspace's Summary / Refresh / Share. What leads follows the dashboard ticket's
 * rule (`leadLive`): Live Mode on the show's own day, for an admin, and for anyone
 * with no band practice; otherwise practice leads and Live Mode sits beside it.
 * Everything rarer — edit details, share link, Excel, reload — is behind `more`
 * (EventMoreMenu, a sheet on a phone).
 *
 * The practice button says where it goes. With the band's room known
 * (`practiceRoomHref`, resolved the way the dashboard ticket resolves it) it reads
 * "ซ้อมตามเซ็ต" and opens that room — the ticket's words, so the same words never
 * lead two places. Without one it opens the Training list, and says so: "ห้องซ้อม".
 *
 * `statusActions` is the approval step when one applies (approve / reject for an
 * approver on a show waiting; resubmit after a rejection). Both components render
 * nothing otherwise, and their row then collapses (`empty:hidden`).
 *
 * No hooks: the web page is a server component. Every action child opens its
 * dialog in a portal, so `.lit`'s overflow and the chamfer clip trap nothing.
 */
export function EventHero({
  event,
  callTime,
  leadLive,
  practiceRoomHref,
  statusActions,
  more,
  children,
}: {
  event: EventHeroEvent;
  /** the show's call time (lib/next-show callTimeOf) — null when it has none */
  callTime: string | null;
  leadLive: boolean;
  /** the band's practice room (`/events/<room>/practice`) when one is known;
   *  without it the button opens the Training list and is labelled for it */
  practiceRoomHref?: string | null;
  statusActions?: ReactNode;
  more?: ReactNode;
  children?: ReactNode;
}) {
  const typeLabel = (EVENT_TYPES[event.event_type as EventType]?.label ?? event.event_type ?? "").split(" (")[0];
  const stage = shortClock(event.show_start_time) || null;
  const callShort = shortClock(callTime) || null;
  // A call time that IS the stage time is said once (lib/next-show showTimesLabel).
  const call = callShort && callShort !== stage ? callShort : null;
  const hardOut = shortClock(event.hard_out_time) || null;
  const dp = dateParts(event.event_date);
  const tiles: { k: string; label: string; value: string; unit?: string; rail?: boolean }[] = [
    { k: "day", label: dp?.wd ?? "วันที่", value: dp?.day ?? "—", unit: dp?.mon },
    ...(call ? [{ k: "call", label: "นัด", value: call }] : []),
    { k: "stage", label: "ขึ้นเวที", value: stage ?? "—", rail: true },
    { k: "out", label: "Hard Out", value: hardOut ?? "—" },
  ];
  const live = `/events/${event.id}/live`;

  return (
    <section
      aria-label="Event"
      className="no-print lit cut sweep p-4"
      style={{ "--cut": "16px" } as CSSProperties}
    >
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        {/* the band's own colour is data (groups.color), so it is an inline style */}
        <i
          aria-hidden
          className="h-2 w-2 flex-none bg-muted-foreground"
          style={event.group?.color ? { background: event.group.color } : undefined}
        />
        <span className="min-w-0 truncate">
          {event.group?.name ?? "—"}
          {typeLabel ? ` · ${typeLabel}` : ""}
        </span>
        <StatusBadge status={event.status as GroupStatus} className="ml-auto shrink-0" />
      </div>

      {/* The name for assistive tech, whole and with its separator; the poster
          below splits it into kicker + slab and is decoration. */}
      <h1 className="sr-only">{event.name}</h1>
      <div aria-hidden className="mt-2">
        <TitleSlab name={event.name ?? ""} size={27} kickerSize={17} />
      </div>

      {(event.venue || event.map_url) && (
        <div className="mt-2 flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <MapPin aria-hidden className="h-[14px] w-[14px] flex-none" />
          <span className="min-w-0 truncate">{event.venue ?? ""}</span>
          {event.map_url && (
            <a
              href={event.map_url}
              target="_blank"
              rel="noreferrer"
              className="-my-3 ml-auto inline-flex h-11 flex-none items-center font-medium text-primary-ink"
            >
              แผนที่
              <ChevronRight aria-hidden className="h-[14px] w-[14px]" />
            </a>
          )}
        </div>
      )}
      {/* Its own line, as on the ticket: beside the status chip it squeezed the
          band name to nothing on a phone. */}
      <DeadlineChip
        deadline={event.deadline}
        exempt={event.group?.exempt_from_deadline}
        note={event.deadline_note}
        className="mt-2"
      />

      <div className={cn("mt-3 grid gap-[2px]", tiles.length === 4 ? "grid-cols-4" : "grid-cols-3")}>
        {tiles.map((t) => (
          <div
            key={t.k}
            className={cn(
              "well min-w-0 px-2 py-1.5",
              // the stage tile carries the band's rail, as the ticket's stub does
              t.rail && "shadow-[inset_3px_0_0_hsl(var(--primary))]"
            )}
          >
            <div className={cn("truncate text-[11px] leading-tight text-muted-foreground", t.k === "day" && "uppercase")}>
              {t.label}
            </div>
            <div className="num truncate text-[24px] leading-[1.1]">
              {t.value}
              {t.unit && <span className="eyebrow ml-1 text-[11px] text-muted-foreground">{t.unit}</span>}
            </div>
          </div>
        ))}
      </div>

      {children}

      {statusActions && <div className="mt-3 flex flex-wrap gap-2 empty:hidden [&>*]:flex-1">{statusActions}</div>}

      <div className="mt-3 flex gap-2">
        {leadLive ? (
          <Button asChild className="min-w-0 flex-1 px-2">
            <Link href={live}>
              <Radio aria-hidden />
              <span className="en">Live Mode</span>
            </Link>
          </Button>
        ) : (
          <>
            <Button asChild className="min-w-0 flex-[1.2] px-2">
              <Link href={practiceRoomHref || "/practice"}>
                <Headphones aria-hidden />
                {practiceRoomHref ? "ซ้อมตามเซ็ต" : "ห้องซ้อม"}
              </Link>
            </Button>
            <Button asChild variant="secondary" className="min-w-0 flex-1 px-2">
              <Link href={live}>
                <Radio aria-hidden />
                <span className="en">Live Mode</span>
              </Link>
            </Button>
          </>
        )}
        {more}
      </div>
    </section>
  );
}
