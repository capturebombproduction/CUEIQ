// Desktop Show Runner — mirrors app/(app)/events/[id]/live/page.tsx. Reuses the
// full LiveMode component verbatim (2.5k lines of show-running + multi-device
// audio), plus the readiness preflight and the on-device snapshot writer, driven
// by a client-fetched bundle. This is the milestone the whole desktop pivot is for.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LiveMode } from "@/components/event/live-mode";
import { ShowReadinessCheck } from "@/components/event/show-readiness-check";
import { EventSnapshotWriter } from "@/components/event/event-snapshot-writer";
import { canLiveEdit, canViewGroup } from "@/lib/permissions";
import { resolveAudioTargets, type SongAudioMap } from "@/lib/audio-targets";
import { loadEventBundle, type EventBundle } from "~/data/event-bundle";
import { useWorkspace } from "~/data/workspace-context";

export function LivePage() {
  const { id } = useParams<{ id: string }>();
  const { ws } = useWorkspace();
  const [state, setState] = useState<{ loading: boolean; bundle: EventBundle | null }>({
    loading: true,
    bundle: null,
  });

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setState({ loading: true, bundle: null });
    loadEventBundle(id)
      .then((bundle) => alive && setState({ loading: false, bundle }))
      .catch(() => alive && setState({ loading: false, bundle: null }));
    return () => {
      alive = false;
    };
  }, [id]);

  if (state.loading) {
    return <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลดโชว์…</p>;
  }

  const bundle = state.bundle;
  // Anyone who can VIEW the event may open Live Mode to rehearse; in-show editing
  // (canLiveEdit) is Admin-only. Band-tier users can't open another band's Live.
  if (!bundle || (ws && !canViewGroup(ws.perms, bundle.event.group_id))) {
    return (
      <div className="space-y-4 py-16 text-center">
        <p className="text-muted-foreground">ไม่พบโชว์นี้ หรือไม่มีสิทธิ์เข้าถึง</p>
        <Button asChild variant="outline">
          <Link to="/dashboard">
            <ArrowLeft className="h-4 w-4" /> กลับไปหน้างานทั้งหมด
          </Link>
        </Button>
      </div>
    );
  }

  const { event } = bundle;
  const canEdit = !!ws && canLiveEdit(ws.perms);

  // song_id → audio, so a library-linked setlist item plays its song file.
  const songAudio: SongAudioMap = Object.fromEntries(
    bundle.songs.map((s) => [s.id, { path: s.audio_path ?? null, name: s.audio_name ?? null }])
  );
  const audioTargets = resolveAudioTargets(bundle.setlist, songAudio);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to={`/events/${event.id}`}>
            <ArrowLeft className="h-4 w-4" /> กลับไปหน้างาน
          </Link>
        </Button>
      </div>
      <ShowReadinessCheck eventId={event.id} targets={audioTargets} />
      {/* Persist this show on-device so it can cold-boot offline later. */}
      <EventSnapshotWriter
        eventId={event.id}
        groupId={event.group_id}
        eventName={event.name}
        items={bundle.setlist}
        songAudio={songAudio}
        canEdit={canEdit}
        lastRunSeconds={event.last_run_seconds ?? null}
        lastRunAt={event.last_run_at ?? null}
      />
      <LiveMode
        eventId={event.id}
        groupId={event.group_id}
        eventName={event.name}
        items={bundle.setlist}
        songAudio={songAudio}
        canEdit={canEdit}
        lastRunSeconds={event.last_run_seconds ?? null}
        lastRunAt={event.last_run_at ?? null}
      />
    </div>
  );
}
