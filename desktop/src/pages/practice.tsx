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
  /** A read came back as an error, so what's below is INCOMPLETE, not empty. */
  partial: boolean;
};

const EMPTY: State = {
  loading: false,
  bundle: null,
  markersBySong: {},
  practiceList: [],
  partial: false,
};

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
      const [markerRes, practiceRes] = await Promise.all([
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
      for (const m of (markerRes.data ?? []) as SongMarker[]) {
        (markersBySong[m.song_id] ??= []).push(m);
      }
      // The last place on the desktop still coercing a FAILED read to []. The
      // bundle above can come off disk, so this room opens with no network — and
      // then both reads fail and the member sees an empty practice list and none
      // of their markers. Nothing is actually lost (both are per-row writes, and
      // re-adding a song hits the unique constraint), but "ลิสต์ว่าง" and "โหลดไม่ได้"
      // are different sentences and only one of them is true. Say which.
      if (alive)
        setState({
          loading: false,
          bundle,
          markersBySong,
          practiceList: (practiceRes.data ?? []) as PracticeSong[],
          partial: !!markerRes.error || !!practiceRes.error,
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
      {state.partial && (
        <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          โหลดลิสต์ซ้อม/มาร์กเกอร์ไม่สำเร็จ — อาจออฟไลน์อยู่ ที่เห็นอาจไม่ครบ ยังไม่มีอะไรหาย
          กดรีเฟรชอีกครั้งเมื่อเน็ตกลับมา
        </p>
      )}
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
