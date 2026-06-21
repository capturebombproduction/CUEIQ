import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getEventBundle, getWorkspace } from "@/lib/queries";
import { canLiveEdit } from "@/lib/permissions";
import { LiveMode } from "@/components/event/live-mode";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function LivePage({
  params,
}: {
  params: { id: string };
}) {
  const bundle = await getEventBundle(params.id);
  if (!bundle) notFound();

  // Anyone who can VIEW the event may open Live Mode to rehearse (playback only);
  // in-show editing + saving the "จบโชว์" record is Admin-only.
  const ws = await getWorkspace();
  const canEdit = canLiveEdit(ws.perms);

  // song_id → audio, so Live Mode can play a library-linked item's song file.
  const songAudio = Object.fromEntries(
    bundle.songs.map((s) => [s.id, { path: s.audio_path ?? null, name: s.audio_name ?? null }])
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href={`/events/${params.id}`}>
            <ArrowLeft className="h-4 w-4" /> กลับไปหน้างาน
          </Link>
        </Button>
      </div>
      <LiveMode
        eventId={bundle.event.id}
        groupId={bundle.event.group_id}
        eventName={bundle.event.name}
        items={bundle.setlist}
        songAudio={songAudio}
        canEdit={canEdit}
        lastRunSeconds={bundle.event.last_run_seconds ?? null}
        lastRunAt={bundle.event.last_run_at ?? null}
      />
    </div>
  );
}
