// Desktop practice room — mirrors app/(app)/events/[id]/practice/page.tsx.
// Reuses PracticeMode verbatim (slow-down/pitch + markers + metronome + journal).
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PracticeMode } from "@/components/practice/practice-mode";
import { createClient } from "@/lib/supabase/client";
import { canEditGroup, canViewGroup } from "@/lib/permissions";
import type { SongMarker, PracticeSong } from "@/lib/types";
import { loadEventBundle, type EventBundle } from "~/data/event-bundle";
import { useWorkspace } from "~/data/workspace-context";

type State = {
  loading: boolean;
  bundle: EventBundle | null;
  markersBySong: Record<string, SongMarker[]>;
  practiceList: PracticeSong[];
};

const EMPTY: State = { loading: false, bundle: null, markersBySong: {}, practiceList: [] };

export function PracticeRoom() {
  const { id } = useParams<{ id: string }>();
  const { ws } = useWorkspace();
  const [state, setState] = useState<State>({ ...EMPTY, loading: true });

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setState({ ...EMPTY, loading: true });
    (async () => {
      const bundle = await loadEventBundle(id);
      if (!bundle || !bundle.event.is_practice) {
        if (alive) setState(EMPTY);
        return;
      }
      const sb = createClient();
      const [{ data: markerRows }, { data: practiceRows }] = await Promise.all([
        sb
          .from("song_markers")
          .select("*")
          .eq("group_id", bundle.event.group_id)
          .order("position_seconds", { ascending: true }),
        sb
          .from("practice_songs")
          .select("*")
          .eq("event_id", bundle.event.id)
          .order("sort_order", { ascending: true }),
      ]);
      const markersBySong: Record<string, SongMarker[]> = {};
      for (const m of (markerRows ?? []) as SongMarker[]) {
        (markersBySong[m.song_id] ??= []).push(m);
      }
      if (alive)
        setState({
          loading: false,
          bundle,
          markersBySong,
          practiceList: (practiceRows ?? []) as PracticeSong[],
        });
    })().catch(() => alive && setState(EMPTY));
    return () => {
      alive = false;
    };
  }, [id]);

  if (state.loading) {
    return <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลดห้องซ้อม…</p>;
  }

  const bundle = state.bundle;
  if (!bundle || (ws && !canViewGroup(ws.perms, bundle.event.group_id))) {
    return (
      <div className="space-y-4 py-16 text-center">
        <p className="text-muted-foreground">ไม่พบห้องซ้อมนี้ หรือไม่มีสิทธิ์เข้าถึง</p>
        <Button asChild variant="outline">
          <Link to="/practice">
            <ArrowLeft className="h-4 w-4" /> กลับไปห้องซ้อม
          </Link>
        </Button>
      </div>
    );
  }

  const canManage = !!ws && canEditGroup(ws.perms, bundle.event.group_id);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/practice">
            <ArrowLeft className="h-4 w-4" /> ห้องซ้อม
          </Link>
        </Button>
      </div>
      <PracticeMode
        roomName={bundle.event.name}
        eventId={bundle.event.id}
        groupId={bundle.event.group_id}
        tenantId={bundle.event.tenant_id}
        songs={bundle.songs}
        practiceList={state.practiceList}
        markersBySong={state.markersBySong}
        members={bundle.members}
        canManage={canManage}
        currentUserId={ws?.user?.id ?? ""}
      />
    </div>
  );
}
