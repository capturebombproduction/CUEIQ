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
import { canLiveEdit, canViewGroup } from "@/lib/permissions";
import {
  resolveAudioTargets,
  resolveLocalOnlyCandidates,
  type SongAudioMap,
} from "@/lib/audio-targets";
import { loadEventBundle, type EventBundle } from "~/data/event-bundle";
import { useWorkspace } from "~/data/workspace-context";
import { ImmersiveLoading } from "~/components/immersive-loading";
import { songSignalMap } from "@/lib/song-signal";

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
    // Immersive route: no header to leave by while the load runs out its budgets.
    return <ImmersiveLoading eventId={id} label="กำลังโหลดโชว์…" />;
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
  // Rows whose song has no online master — either this device holds the file
  // (an upload queued at a venue) or that row will be silent. Either way the
  // preflight has to see them; resolveAudioTargets deliberately does not.
  const localOnly = resolveLocalOnlyCandidates(bundle.setlist, songAudio);

  // Immersive (the shell drops its header and its <main> padding on this route):
  // the back link is in Live Mode's own top bar.
  // Stage size: Live Mode's root is one screen tall over a FIXED 112 px dock, so the
  // card in flow above it pushed the board's bottom — the NOW card's fade and volume
  // rows — under the dock. The page is that one-screen column instead: the card takes
  // its share (capped, scrolling inside itself once it opens) and Live Mode's root the
  // rest; `> .live-root` (0,2,0) outranks the root's own `stage:h-[100dvh]` (0,1,0).
  // Where the card should live in the end is still พี่'s call
  // (review-shots/design/PLANS-surfaces-critic.md, finding L6).
  return (
    <div className="stage:flex stage:h-[100dvh] stage:flex-col stage:[&>.live-root]:h-auto stage:[&>.live-root]:min-h-0 stage:[&>.live-root]:flex-1">
      {/* `setlist` is what lets the preflight reconcile rows against the resolvers —
          without it a row whose song was deleted leaves no trace in either list and
          the check prints a green "พร้อมโชว์ออฟไลน์" over a track that plays nothing.
          Round 10 built that guard and never passed this prop. */}
      {/* Its own gutter now that <main> has none; `empty:hidden` when it has nothing to say. */}
      {/* Below `stage` the card is in flow with no row to share, so an opened one (a
          long list of missing files) pushed Live Mode a screen down; capped here at
          40dvh, scrolling inside itself. At `stage` the 30dvh cap on this same element
          takes over (it wins: variants come after the plain utility). */}
      <div className="px-4 pt-3 empty:hidden max-h-[40dvh] overflow-y-auto stage:max-h-[30dvh] stage:shrink-0 stage:overflow-y-auto stage:px-5">
        <ShowReadinessCheck
          eventId={event.id}
          targets={audioTargets}
          localOnly={localOnly}
          setlist={bundle.setlist}
        />
      </div>
      <LiveMode
        eventId={event.id}
        groupId={event.group_id}
        eventName={event.name}
        items={bundle.setlist}
        songAudio={songAudio}
        songSignal={songSignalMap(bundle.songs)}
        canEdit={canEdit}
        lastRunSeconds={event.last_run_seconds ?? null}
        lastRunAt={event.last_run_at ?? null}
        eventDate={event.event_date ?? null}
        showStartTime={event.show_start_time ?? null}
        hardOutTime={event.hard_out_time ?? null}
        userId={ws?.user?.id ?? null}
        tenantId={ws?.membership?.tenant_id ?? null}
      />
    </div>
  );
}
