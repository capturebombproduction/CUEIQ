import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getEventBundle, getWorkspace } from "@/lib/queries";
import { canEditGroup, canViewGroup } from "@/lib/permissions";
import { PracticeMode } from "@/components/practice/practice-mode";
import type { SongMarker, PracticeSong } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function PracticePlayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const bundle = await getEventBundle(id);
  if (!bundle) notFound();
  // This route is only for practice rooms — a normal event opens in Live Mode.
  if (!bundle.event.is_practice) redirect(`/events/${id}`);

  const ws = await getWorkspace();
  if (!ws.user) redirect("/dashboard");
  // Per-band scope: a band-tier user can't open another band's practice room by
  // URL (RLS is tenant-wide, so guard here).
  if (!canViewGroup(ws.perms, bundle.event.group_id)) notFound();
  // Ar (or admin) of the band manages markers/notes/attendance; members jump + play
  // + add shared notes. RLS enforces the real boundary.
  const canManage = canEditGroup(ws.perms, bundle.event.group_id);

  const supabase = await createClient();
  // Section markers for the whole band library, grouped by song (reusable per song),
  // and this room's practice list (member-curated).
  const [{ data: markerRows }, { data: practiceRows }] = await Promise.all([
    supabase
      .from("song_markers")
      .select("*")
      .eq("group_id", bundle.event.group_id)
      .order("position_seconds", { ascending: true }),
    supabase
      .from("practice_songs")
      .select("*")
      .eq("event_id", bundle.event.id)
      .order("sort_order", { ascending: true }),
  ]);
  const markersBySong: Record<string, SongMarker[]> = {};
  for (const m of (markerRows ?? []) as SongMarker[]) {
    (markersBySong[m.song_id] ??= []).push(m);
  }
  const practiceList = (practiceRows ?? []) as PracticeSong[];

  return (
    <div className="space-y-3">
      {/* On a phone the header already reads "‹ TRAINING" (components/header-brand.tsx);
          from lg the header shows the wordmark, so the way back sits here — at the
          top-left, inside the page light's hot core (FRAME_LIGHT_AIM). 15 px band ink
          there fell to 4.26:1 on Sakura (light), so the word is ink and the band
          colour stays on the chevron, as `.lit .eyebrow` does inside a glow. */}
      <Link
        href="/practice"
        className="caps -ml-2 hidden h-11 w-fit items-center gap-0.5 rounded-[3px] pr-2 text-[15px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:flex"
      >
        <ChevronLeft className="h-5 w-5 text-primary-ink" strokeWidth={2.6} aria-hidden />
        Training
      </Link>
      <PracticeMode
        roomName={bundle.event.name}
        eventId={bundle.event.id}
        groupId={bundle.event.group_id}
        tenantId={bundle.event.tenant_id}
        songs={bundle.songs}
        practiceList={practiceList}
        markersBySong={markersBySong}
        members={bundle.members}
        canManage={canManage}
        currentUserId={ws.user.id}
      />
    </div>
  );
}
