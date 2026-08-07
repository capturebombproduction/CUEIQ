import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getEventRow, getWorkspace } from "@/lib/queries";
import { canApprove, canEditGroup, editableGroups } from "@/lib/permissions";
import { EventForm } from "@/components/event/event-form";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function EditEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // getEventRow, NOT getEventBundle: this form is built entirely from the event
  // row, so a failed read of the setlist / mic map / song library has nothing to
  // do with it. Loading the whole bundle here meant a statement timeout on the
  // band's library select locked the Ar out of pushing show_start_time back on
  // show day, on a page where every field they needed had read fine.
  const event = await getEventRow(id);
  if (!event) notFound();
  const ws = await getWorkspace();
  if (!canEditGroup(ws.perms, event.group_id)) {
    redirect(`/events/${id}`);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link href={`/events/${id}`}>
            <ArrowLeft className="h-4 w-4" /> กลับไปหน้างาน
          </Link>
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">แก้ไขข้อมูลงาน</h1>
      </div>
      <EventForm
        mode="edit"
        event={event}
        tenantId={event.tenant_id}
        userId={ws.user?.id}
        groups={editableGroups(ws.perms, ws.groups)}
        canApprove={canApprove(ws.perms)}
      />
    </div>
  );
}
