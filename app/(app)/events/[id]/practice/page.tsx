import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getEventBundle, getWorkspace } from "@/lib/queries";
import { canEditGroup } from "@/lib/permissions";
import { PracticeMode } from "@/components/practice/practice-mode";
import { FullscreenButton } from "@/components/fullscreen-button";
import { Button } from "@/components/ui/button";
import type { SongMarker } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function PracticePlayPage({
  params,
}: {
  params: { id: string };
}) {
  const bundle = await getEventBundle(params.id);
  if (!bundle) notFound();
  // This route is only for practice rooms — a normal event opens in Live Mode.
  if (!bundle.event.is_practice) redirect(`/events/${params.id}`);

  const ws = await getWorkspace();
  if (!ws.user) redirect("/dashboard");
  // Ar (or admin) of the band manages markers/notes/attendance; members jump + play
  // + add shared notes. RLS enforces the real boundary.
  const canManage = canEditGroup(ws.perms, bundle.event.group_id);

  // Section markers for the whole band library, grouped by song (reusable per song).
  const supabase = createClient();
  const { data: markerRows } = await supabase
    .from("song_markers")
    .select("*")
    .eq("group_id", bundle.event.group_id)
    .order("position_seconds", { ascending: true });
  const markersBySong: Record<string, SongMarker[]> = {};
  for (const m of (markerRows ?? []) as SongMarker[]) {
    (markersBySong[m.song_id] ??= []).push(m);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/practice">
            <ArrowLeft className="h-4 w-4" /> ห้องซ้อม
          </Link>
        </Button>
        <FullscreenButton />
      </div>
      <PracticeMode
        roomName={bundle.event.name}
        eventId={bundle.event.id}
        groupId={bundle.event.group_id}
        tenantId={bundle.event.tenant_id}
        songs={bundle.songs}
        markersBySong={markersBySong}
        members={bundle.members}
        canManage={canManage}
        currentUserId={ws.user.id}
      />
    </div>
  );
}
