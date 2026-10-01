import { getMembers, getWorkspace } from "@/lib/queries";
import { JoinDemo } from "@/components/join-demo";
import { GroupManager } from "@/components/group/group-manager";
import { RefreshButton } from "@/components/refresh-button";
import { PageTitle } from "@/components/page-title";
import { ConfirmSavedBar } from "@/components/confirm-saved-bar";
import { canEditAnyGroup, viewableGroups } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) {
    return <JoinDemo />;
  }

  // Per-band scope: a band-tier user manages only their own band's roster;
  // admin/ceo see every band.
  const bands = viewableGroups(ws.perms, ws.groups);
  const members = await getMembers(
    ws.membership.tenant_id,
    bands.map((g) => g.id)
  );

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <PageTitle title="Artists" right={<RefreshButton />} />
        <p className="text-[14px] text-muted-foreground">
          {ws.tenant.name} · <span className="num text-[16px] text-foreground">{bands.length}</span> วง ·
          สมาชิก · ไมค์ · สีประจำตัว
        </p>
      </div>
      <GroupManager
        tenantId={ws.membership.tenant_id}
        initialGroups={bands}
        initialMembers={members}
        perms={ws.perms}
      />
      {canEditAnyGroup(ws.perms) && (
        <ConfirmSavedBar note="ข้อมูลวง/สมาชิกบันทึกอัตโนมัติทุกครั้งที่แก้ — ปุ่มนี้ยืนยัน + โหลดข้อมูลล่าสุด" />
      )}
    </div>
  );
}
