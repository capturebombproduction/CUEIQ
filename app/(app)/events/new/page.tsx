import { redirect } from "next/navigation";
import { getWorkspace } from "@/lib/queries";
import { canApprove, canCreateAnyEvent, editableGroups } from "@/lib/permissions";
import { EventForm } from "@/components/event/event-form";
import { Card, CardContent } from "@/components/ui/card";
import { PageTitle } from "@/components/page-title";

export const dynamic = "force-dynamic";

export default async function NewEventPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant || !ws.user) redirect("/dashboard");
  if (!canCreateAnyEvent(ws.perms)) redirect("/dashboard");

  // An Ar may only create events for the band(s) they manage; admin sees all.
  const groups = editableGroups(ws.perms, ws.groups);

  return (
    <div className="mx-auto max-w-2xl space-y-3">
      {/* The way back is the header's "‹ EVENTS" (and the form's ยกเลิก) — a second
          back link here said the same thing twice (spec §G.3). */}
      <PageTitle title="New Event" />
      <p className="text-[13px] text-muted-foreground">สร้างงานใหม่ — เติมเซ็ตลิสต์ ตารางเวลา และไมค์ได้หลังสร้าง</p>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            ยังไม่มีวงที่คุณดูแล — ติดต่อแอดมินเพื่อขอสิทธิ์จัดการวง
          </CardContent>
        </Card>
      ) : (
        <EventForm
          mode="create"
          tenantId={ws.membership.tenant_id}
          userId={ws.user.id}
          groups={groups}
          defaultGroupId={groups[0]?.id}
          canApprove={canApprove(ws.perms)}
        />
      )}
    </div>
  );
}
