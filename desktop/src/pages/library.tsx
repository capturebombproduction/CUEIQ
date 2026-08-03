// Desktop คลังเพลง — mirrors app/(app)/library/page.tsx. Reuses SongLibrary
// verbatim (song CRUD + audio upload). On Electron the file-pick opens the native
// dialog and the upload routes through the main-process bridge (no CORS), so this
// IS the dual-source / master model: a song's audio_path is the single online
// master, and uploading a new file overwrites it (newer-upload-wins).
import { useEffect, useState } from "react";
import { RefreshButton } from "@/components/refresh-button";
import { SongLibrary } from "@/components/song/song-library";
import { Card, CardContent } from "@/components/ui/card";
import { canViewLibrary, viewableGroups } from "@/lib/permissions";
import type { Song } from "@/lib/types";
import { fetchSongs, readCachedSongs } from "~/data/song-library";
import { useWorkspace } from "~/data/workspace-context";

export function Library() {
  const { ws } = useWorkspace();
  const [songs, setSongs] = useState<Song[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const bands = ws ? viewableGroups(ws.perms, ws.groups) : [];
  const ids = bands.map((g) => g.id);
  const key = ids.join(",");

  // Read-cached like the dashboard and the event bundles. Without this the
  // catalogue is simply unreachable with no network — and that locks the door on
  // the one thing the offline audio-upload queue exists for: picking a file for a
  // song AT THE VENUE, playing it here immediately, and pushing it as the master
  // when the network comes back. The picker lives on this page. The fetch + its
  // cache rules live in ~/data/song-library so the dashboard can warm the very
  // same entry on the way past (a fresh install never opens this page first).
  const tenantId = ws?.membership?.tenant_id ?? null;
  useEffect(() => {
    if (!ws?.membership) return;
    if (ids.length === 0) {
      setSongs([]);
      return;
    }
    let alive = true;
    const tid = ws.membership.tenant_id;
    (async () => {
      // null = a read we can't trust (offline / postgrest error / anon refusal);
      // a throw is the same story. A failed read is NOT an empty catalogue, so
      // neither may ever render "0 เพลง".
      let rows: Song[] | null = null;
      try {
        rows = await fetchSongs(tid, ids);
      } catch {
        rows = null;
      }
      if (!alive) return;
      const served = rows ?? readCachedSongs(tid, ids);
      if (!served) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      setSongs(served);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, key]);

  if (!ws?.membership || !ws.tenant) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          บัญชีนี้ยังไม่ได้ผูกกับ Label
        </CardContent>
      </Card>
    );
  }
  if (!canViewLibrary(ws.perms)) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          บัญชีนี้ไม่มีสิทธิ์เข้าคลังเพลง
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">คลังเพลง</h1>
          <p className="text-sm text-muted-foreground">
            {ws.tenant.name}
            {songs ? ` · ${songs.length} เพลง` : ""}
          </p>
        </div>
        <RefreshButton />
      </div>
      {songs === null && loadError ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
            <p>โหลดคลังเพลงไม่สำเร็จ — อาจออฟไลน์อยู่หรือเน็ตมีปัญหา ลองใหม่เมื่อเน็ตกลับมา</p>
            <RefreshButton label="ลองใหม่" />
          </CardContent>
        </Card>
      ) : songs === null ? (
        <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลดคลังเพลง…</p>
      ) : (
        <SongLibrary
          tenantId={ws.membership.tenant_id}
          groups={bands}
          initialSongs={songs}
          perms={ws.perms}
        />
      )}
    </div>
  );
}
