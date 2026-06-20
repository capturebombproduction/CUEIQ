import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getEventBundle, getWorkspace } from "@/lib/queries";
import { canEditGroup, editableGroups } from "@/lib/permissions";
import { EventForm } from "@/components/event/event-form";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function EditEventPage({
  params,
}: {
  params: { id: string };
}) {
  const bundle = await getEventBundle(params.id);
  if (!bundle) notFound();
  const ws = await getWorkspace();
  if (!canEditGroup(ws.perms, bundle.event.group_id)) {
    redirect(`/events/${params.id}`);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link href={`/events/${params.id}`}>
            <ArrowLeft className="h-4 w-4" /> กลับไปหน้างาน
          </Link>
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">แก้ไขข้อมูลงาน</h1>
      </div>
      <EventForm
        mode="edit"
        event={bundle.event}
        tenantId={bundle.event.tenant_id}
        userId={ws.user?.id}
        groups={editableGroups(ws.perms, ws.groups)}
      />
    </div>
  );
}
