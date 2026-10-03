import { notFound } from "next/navigation";
import { getEventBundle, getWorkspace } from "@/lib/queries";
import { canLiveEdit, canViewGroup } from "@/lib/permissions";
import { type SongAudioMap } from "@/lib/audio-targets";
import { LiveMode } from "@/components/event/live-mode";
import { songSignalMap } from "@/lib/song-signal";

export const dynamic = "force-dynamic";

export default async function LivePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const bundle = await getEventBundle(id);
  if (!bundle) notFound();

  // Anyone who can VIEW the event may open Live Mode to rehearse (playback only);
  // in-show editing + saving the "จบโชว์" record is Admin-only. Per-band scope: a
  // band-tier user can't open another band's Live by URL (RLS is tenant-wide).
  const ws = await getWorkspace();
  if (!canViewGroup(ws.perms, bundle.event.group_id)) notFound();
  const canEdit = canLiveEdit(ws.perms);

  // song_id → audio, so Live Mode can play a library-linked item's song file.
  const songAudio: SongAudioMap = Object.fromEntries(
    bundle.songs.map((s) => [s.id, { path: s.audio_path ?? null, name: s.audio_name ?? null }])
  );

  // Immersive: no app chrome on this route (components/chrome-gate.tsx). The back
  // link lives in Live Mode's own top bar, so LiveMode IS the page — keep it at
  // this one stable position (a remount would restart the audio engine).
  return (
    <LiveMode
      eventId={bundle.event.id}
      groupId={bundle.event.group_id}
      eventName={bundle.event.name}
      items={bundle.setlist}
      songAudio={songAudio}
      songSignal={songSignalMap(bundle.songs)}
      canEdit={canEdit}
      lastRunSeconds={bundle.event.last_run_seconds ?? null}
      lastRunAt={bundle.event.last_run_at ?? null}
      userId={ws.user?.id ?? null}
      tenantId={ws.membership?.tenant_id ?? null}
    />
  );
}
