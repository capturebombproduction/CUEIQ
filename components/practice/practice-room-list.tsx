import type { CSSProperties } from "react";
import Link from "next/link";
import {
  BookOpen,
  ChevronRight,
  Disc3,
  Headphones,
  ListMusic,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeletePracticeRoomButton } from "@/components/practice/delete-practice-room-button";
import {
  continueRoomId,
  lastRunWhen,
  type PracticeRoomStats,
} from "@/components/practice/practice-room-stats";
import { bkkTodayKey } from "@/lib/time";

export type PracticeRoomRow = {
  id: string;
  name: string;
  group_id: string;
  groups: { name: string; color: string | null } | null;
};

/** "ล่าสุด 13:20 · Neon Samurai ที่ 0.75×" — numerals in Barlow, the speed only when slowed. */
function LastRunLine({
  run,
  todayKey,
  big = false,
}: {
  run: NonNullable<PracticeRoomStats["lastRun"]>;
  todayKey: string;
  big?: boolean;
}) {
  const { day, time } = lastRunWhen(run.at, todayKey);
  const n = big ? "num text-[16px] text-foreground" : "num text-[14px] text-foreground/85";
  return (
    <>
      ล่าสุด {day && <>{day} </>}
      <span className={n}>{time}</span> · {run.title}
      {run.speed && run.speed !== 1 ? (
        <>
          {" "}
          ที่ <span className={n}>{run.speed}×</span>
        </>
      ) : null}
    </>
  );
}

/** The counts a room has, as chips — only the ones known and above zero. */
function StatChips({ s }: { s: PracticeRoomStats }) {
  const chips = [];
  if (s.songs) {
    chips.push(
      <Badge key="songs" variant="secondary">
        <ListMusic aria-hidden />
        <span className="num text-[14px]">{s.songs}</span> เพลง
      </Badge>
    );
  }
  if (s.homework) {
    chips.push(
      <Badge key="hw" variant="info">
        <BookOpen aria-hidden />
        การบ้าน <span className="num text-[14px]">{s.homework}</span>
      </Badge>
    );
  }
  if (s.problems) {
    chips.push(
      <Badge key="pb" variant="warning">
        <TriangleAlert aria-hidden />
        ปัญหา <span className="num text-[14px]">{s.problems}</span>
      </Badge>
    );
  }
  return chips.length ? <span className="mt-1.5 flex flex-wrap gap-1">{chips}</span> : null;
}

/**
 * The Training landing (spec §G.6, §G.2's practice hero): the room someone ran a
 * song in most recently as the ONE lit hero — "continue practising" — then every
 * room as a slab: band rail, name, last session, song / homework / problem chips.
 * The whole slab opens the room; delete sits behind its ⋯.
 *
 * Shared by the web page (server-rendered, stats read on the server), the desktop
 * page and the gallery harness. `stats` may be missing (still loading, offline):
 * the rooms still list, they just say less — never a made-up 0.
 */
export function PracticeRoomList({
  rooms,
  stats,
  deletableIds,
  todayKey = bkkTodayKey(),
}: {
  rooms: PracticeRoomRow[];
  stats?: Record<string, PracticeRoomStats>;
  deletableIds: readonly string[];
  todayKey?: string;
}) {
  const heroId = continueRoomId(stats);
  const hero = heroId ? rooms.find((r) => r.id === heroId) ?? null : null;
  const heroStats = hero ? stats?.[hero.id] : undefined;
  const heroRun = heroStats?.lastRun ?? null;
  const tiles =
    heroStats &&
    heroStats.songs !== undefined &&
    heroStats.homework !== undefined &&
    heroStats.problems !== undefined
      ? ([
          ["เพลงในห้อง", heroStats.songs],
          ["การบ้าน", heroStats.homework],
          ["ปัญหา", heroStats.problems],
        ] as const)
      : null;

  return (
    <div className="space-y-6">
      {hero && heroRun && (
        <section
          aria-label="Continue practising"
          className="lit cut sweep p-4"
          style={{ "--cut": "22px" } as CSSProperties}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="eyebrow key">Continue</span>
            {lastRunWhen(heroRun.at, todayKey).day === null && (
              <Badge variant="secondary">
                <Headphones aria-hidden />
                ซ้อมวันนี้
              </Badge>
            )}
          </div>
          <h2 className="mt-2 text-[24px] font-bold leading-tight">{hero.name}</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            <LastRunLine run={heroRun} todayKey={todayKey} big />
          </p>
          {tiles && (
            <div className="mt-3 grid grid-cols-3 gap-[3px]">
              {tiles.map(([label, value]) => (
                <div key={label} className="well rounded-[2px] px-3 py-2">
                  <div className="text-[11.5px] text-muted-foreground">{label}</div>
                  <div className="num text-[42px] font-extrabold leading-none">{value}</div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3.5 grid grid-cols-[1.6fr_1fr] gap-2">
            <Button asChild className="h-12">
              <Link href={`/events/${hero.id}/practice`}>
                <Headphones aria-hidden />
                ซ้อมต่อ
              </Link>
            </Button>
            <Button asChild variant="secondary" className="h-12">
              <Link href="/library">
                <Disc3 aria-hidden />
                <span className="en">Library</span>
              </Link>
            </Button>
          </div>
        </section>
      )}

      <section className="space-y-2.5" aria-label="Rooms">
        <div className="flex items-baseline justify-between gap-3 px-0.5">
          <h2 className="h2">Rooms</h2>
          <span className="text-[13px] text-muted-foreground">
            ห้องซ้อม · <span className="num text-[15px] text-foreground">{rooms.length}</span>
          </span>
        </div>
        <ul className="stack">
          {rooms.map((room) => {
            const s = stats?.[room.id];
            const band = room.groups?.color ?? null;
            return (
              <li
                key={room.id}
                className="slab flex items-stretch"
                style={{
                  boxShadow: `inset 4px 0 0 ${band ?? "hsl(var(--muted-foreground))"}, inset 0 0 0 1px hsl(var(--border))`,
                }}
              >
                <Link
                  href={`/events/${room.id}/practice`}
                  className="flex min-h-[64px] min-w-0 flex-1 items-center gap-3 rounded-[2px] py-2.5 pl-4 pr-2 transition-colors duration-2 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[16px] font-semibold leading-tight">
                      {room.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                      {room.groups?.name ?? "—"}
                      {s?.lastRun && (
                        <>
                          {" · "}
                          <LastRunLine run={s.lastRun} todayKey={todayKey} />
                        </>
                      )}
                    </span>
                    {s && <StatChips s={s} />}
                  </span>
                  <ChevronRight className="h-5 w-5 shrink-0 text-faint" aria-hidden />
                </Link>
                {deletableIds.includes(room.id) && (
                  <div className="flex items-center pr-1">
                    <DeletePracticeRoomButton roomId={room.id} roomName={room.name} variant="menu" />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
