import { redirect } from "next/navigation";
import { getSongs, getWorkspace } from "@/lib/queries";
import { JoinDemo } from "@/components/join-demo";
import { SongLibrary } from "@/components/song/song-library";
import { LibraryCount } from "@/components/song/library-count";
import { PageTitle } from "@/components/page-title";
import { RefreshButton } from "@/components/refresh-button";
import { ConfirmSavedBar } from "@/components/confirm-saved-bar";
import {
  canApprove,
  canEditAnyGroup,
  canViewLibrary,
  viewableGroups,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) {
    return <JoinDemo />;
  }
  // label_staff is proof-only and never needs the catalogue — bounce them so
  // their device never loads the song library at all.
  if (!canViewLibrary(ws.perms)) redirect("/dashboard");

  // Per-band scope: a band-tier user sees only their own band's songs; admin/ceo
  // see every band. Drives both the rows loaded and the band filter/selectors.
  const bands = viewableGroups(ws.perms, ws.groups);
  const songs = await getSongs(
    ws.membership.tenant_id,
    bands.map((g) => g.id)
  );

  return (
    <div className="space-y-4">
      <PageTitle
        title="Library"
        right={
          <LibraryCount
            count={songs.length}
            scope={bands.length === 1 ? bands[0].name : ws.tenant.name}
          />
        }
      />
      <SongLibrary
        tenantId={ws.membership.tenant_id}
        groups={bands}
        initialSongs={songs}
        perms={ws.perms}
        toolbarEnd={<RefreshButton variant="secondary" className="h-[46px] px-3" />}
        // Inside the library, not after it: the room kept for the preview player is
        // the library's last child, so anything placed after it ends under the player.
        footer={
          (canEditAnyGroup(ws.perms) || canApprove(ws.perms)) && (
            <ConfirmSavedBar note="เพลงบันทึกอัตโนมัติทุกครั้งที่เพิ่ม/แก้ — ปุ่มนี้ยืนยัน + โหลดข้อมูลล่าสุด" />
          )
        }
      />
    </div>
  );
}
