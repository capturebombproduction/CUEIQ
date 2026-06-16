import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getWorkspace } from "@/lib/queries";
import { canEdit } from "@/lib/types";
import { EventForm } from "@/components/event/event-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function NewEventPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant || !ws.user) redirect("/dashboard");
  if (!canEdit(ws.membership.role)) redirect("/dashboard");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link href="/dashboard">
            <ArrowLeft className="h-4 w-4" /> กลับ
          </Link>
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">สร้างงานใหม่</h1>
      </div>

      {ws.groups.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            ยังไม่มีวงในค่ายนี้ — ต้องเพิ่มวงก่อน (รัน seed.sql
            เพื่อสร้างวง VANTAFLARE ตัวอย่าง)
          </CardContent>
        </Card>
      ) : (
        <EventForm
          mode="create"
          tenantId={ws.membership.tenant_id}
          userId={ws.user.id}
          groups={ws.groups}
          defaultGroupId={ws.groups[0]?.id}
        />
      )}
    </div>
  );
}
