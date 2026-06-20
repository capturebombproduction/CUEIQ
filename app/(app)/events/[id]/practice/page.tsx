import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getEventBundle } from "@/lib/queries";
import { PracticeMode } from "@/components/practice/practice-mode";
import { FullscreenButton } from "@/components/fullscreen-button";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function PracticePlayPage({
  params,
}: {
  params: { id: string };
}) {
  const bundle = await getEventBundle(params.id);
  if (!bundle) notFound();
  // This route is only for practice rooms — a normal event opens in Live Mode.
  if (!bundle.event.is_practice) redirect(`/events/${params.id}`);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/practice">
            <ArrowLeft className="h-4 w-4" /> ห้องซ้อม
          </Link>
        </Button>
        <FullscreenButton />
      </div>
      <PracticeMode roomName={bundle.event.name} songs={bundle.songs} />
    </div>
  );
}
