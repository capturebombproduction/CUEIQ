import { getMembers, getWorkspace } from "@/lib/queries";
import { JoinDemo } from "@/components/join-demo";
import { GroupManager } from "@/components/group/group-manager";
import { RefreshButton } from "@/components/refresh-button";
import { ConfirmSavedBar } from "@/components/confirm-saved-bar";
import { canEdit } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) {
    return <JoinDemo />;
  }

  const members = await getMembers(ws.membership.tenant_id);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">จัดการวง</h1>
          <p className="text-sm text-muted-foreground">
            {ws.tenant.name} · {ws.groups.length} วง
          </p>
        </div>
        <RefreshButton />
      </div>
      <GroupManager
        tenantId={ws.membership.tenant_id}
        initialGroups={ws.groups}
        initialMembers={members}
        editable={canEdit(ws.membership.role)}
      />
      {canEdit(ws.membership.role) && (
        <ConfirmSavedBar note="ข้อมูลวง/สมาชิกบันทึกอัตโนมัติทุกครั้งที่แก้ — ปุ่มนี้ยืนยัน + โหลดข้อมูลล่าสุด" />
      )}
    </div>
  );
}
