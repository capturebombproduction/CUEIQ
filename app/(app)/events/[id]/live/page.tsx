import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getEventBundle } from "@/lib/queries";
import { LiveMode } from "@/components/event/live-mode";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function LivePage({
  params,
}: {
  params: { id: string };
}) {
  const bundle = await getEventBundle(params.id);
  if (!bundle) notFound();

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href={`/events/${params.id}`}>
          <ArrowLeft className="h-4 w-4" /> กลับไปหน้างาน
        </Link>
      </Button>
      <LiveMode
        eventId={bundle.event.id}
        eventName={bundle.event.name}
        items={bundle.setlist}
      />
    </div>
  );
}
