import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getEventRow, getWorkspace } from "@/lib/queries";
import { canApprove, canEditGroup, editableGroups } from "@/lib/permissions";
import { EventForm } from "@/components/event/event-form";
import { Button } from "@/components/ui/button";
import { PageTitle } from "@/components/page-title";

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
    // data-stage-centred: one centred column (components/stage-light.tsx)
    <div data-stage-centred className="mx-auto max-w-2xl space-y-3">
      {/* Back to THIS show — the header's "‹ EVENTS" goes up to the list, a
          different place, so this one stays. */}
      <Button asChild variant="ghost" className="no-print -ml-3 text-primary-ink">
        <Link href={`/events/${id}`}>
          <ArrowLeft aria-hidden /> กลับไปหน้างาน
        </Link>
      </Button>
      <PageTitle title="Edit Event" />
      <p className="truncate text-[13px] text-muted-foreground">แก้ไขข้อมูลงาน — {event.name}</p>
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
