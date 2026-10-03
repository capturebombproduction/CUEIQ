import {
  AudioWaveform,
  Film,
  Guitar,
  Mic,
  Music,
  Star,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SETLIST_KIND_LABELS, SETLIST_KIND_SHORT, type SetlistKind } from "@/lib/types";

// Setlist kinds told apart by LIGHTNESS + icon + word (spec §E.11), never hue alone:
// a song is the solid band, SE / INST / INT outlined or dashed, MC / GUEST a neutral
// fill. The band colour appears on songs only, so a run of songs reads as "the set".
const KIND_META: Record<SetlistKind, { Icon: LucideIcon; tile: string; chip: string }> = {
  song: { Icon: Music, tile: "kind-song", chip: "chip-primary" },
  se: { Icon: AudioWaveform, tile: "kind-se", chip: "chip-neutral" },
  instrument: { Icon: Guitar, tile: "kind-se", chip: "chip-neutral" },
  mc: { Icon: Mic, tile: "kind-mc", chip: "chip-neutral" },
  guest: { Icon: Star, tile: "kind-mc", chip: "chip-neutral" },
  interlude: { Icon: Film, tile: "kind-int", chip: "chip-neutral" },
};

/** An unknown kind from older data shows as a neutral SE-style item, not a crash. */
function metaOf(kind: SetlistKind) {
  const known = Object.prototype.hasOwnProperty.call(KIND_META, kind);
  return {
    ...(known ? KIND_META[kind] : KIND_META.se),
    short: known ? SETLIST_KIND_SHORT[kind] : String(kind ?? "").toUpperCase(),
    label: known ? SETLIST_KIND_LABELS[kind] : String(kind ?? ""),
  };
}

/** The 36 px square at the start of a setlist row: icon only, the kind named for AT. */
export function KindTile({
  kind,
  cover = null,
  className,
}: {
  kind: SetlistKind;
  /** the song's cover (songs.cover): shown in the same square in place of the icon, so
   *  the row keeps its size; the kind is still named for AT */
  cover?: string | null;
  className?: string;
}) {
  const { Icon, tile, short, label } = metaOf(kind);
  if (cover)
    return (
      <span role="img" aria-label={short} title={label} className={cn("kind overflow-hidden bg-muted", className)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a 192 px data-URL thumbnail */}
        <img src={cover} alt="" className="h-full w-full object-cover" />
      </span>
    );
  return (
    <span role="img" aria-label={short} title={label} className={cn("kind", tile, className)}>
      <Icon aria-hidden />
    </span>
  );
}

/** Icon + the short English word (SONG, MC, SE …), e.g. beside a Live title. */
export function KindChip({ kind, className }: { kind: SetlistKind; className?: string }) {
  const { Icon, chip, short } = metaOf(kind);
  return (
    <span className={cn("chip en", chip, className)}>
      <Icon aria-hidden />
      {short}
    </span>
  );
}
