import { getMembers, getWorkspace } from "@/lib/queries";
import { JoinDemo } from "@/components/join-demo";
import { GroupManager } from "@/components/group/group-manager";
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
      <div>
        <h1 className="text-2xl font-bold tracking-tight">จัดการวง</h1>
        <p className="text-sm text-muted-foreground">
          {ws.tenant.name} · {ws.groups.length} วง
        </p>
      </div>
      <GroupManager
        tenantId={ws.membership.tenant_id}
        initialGroups={ws.groups}
        initialMembers={members}
        editable={canEdit(ws.membership.role)}
      />
    </div>
  );
}
