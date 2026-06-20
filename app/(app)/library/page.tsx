import { getSongs, getWorkspace } from "@/lib/queries";
import { JoinDemo } from "@/components/join-demo";
import { SongLibrary } from "@/components/song/song-library";
import { RefreshButton } from "@/components/refresh-button";
import { ConfirmSavedBar } from "@/components/confirm-saved-bar";
import { canApprove, canEditAnyGroup } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) {
    return <JoinDemo />;
  }

  const songs = await getSongs(ws.membership.tenant_id);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">คลังเพลง</h1>
          <p className="text-sm text-muted-foreground">
            {ws.tenant.name} · {songs.length} เพลง
          </p>
        </div>
        <RefreshButton />
      </div>
      <SongLibrary
        tenantId={ws.membership.tenant_id}
        groups={ws.groups}
        initialSongs={songs}
        perms={ws.perms}
      />
      {(canEditAnyGroup(ws.perms) || canApprove(ws.perms)) && (
        <ConfirmSavedBar note="เพลงบันทึกอัตโนมัติทุกครั้งที่เพิ่ม/แก้ — ปุ่มนี้ยืนยัน + โหลดข้อมูลล่าสุด" />
      )}
    </div>
  );
}
