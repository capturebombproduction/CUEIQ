import { getSongs, getWorkspace } from "@/lib/queries";
import { JoinDemo } from "@/components/join-demo";
import { SongLibrary } from "@/components/song/song-library";
import { canEdit } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) {
    return <JoinDemo />;
  }

  const songs = await getSongs(ws.membership.tenant_id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">คลังเพลง</h1>
        <p className="text-sm text-muted-foreground">
          {ws.tenant.name} · {songs.length} เพลง
        </p>
      </div>
      <SongLibrary
        tenantId={ws.membership.tenant_id}
        groups={ws.groups}
        initialSongs={songs}
        editable={canEdit(ws.membership.role)}
      />
    </div>
  );
}
