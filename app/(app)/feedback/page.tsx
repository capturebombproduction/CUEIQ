import { redirect } from "next/navigation";
import { MessagesSquare } from "lucide-react";
import { getWorkspace } from "@/lib/queries";
import { MyFeedbackList } from "@/components/my-feedback-list";

export const dynamic = "force-dynamic";

/**
 * Where a "ทีมงานตอบฟีดแบคของคุณแล้ว" notification lands.
 *
 * The same list also lives inside the แจ้งปัญหา dialog, which is where people
 * actually find it — but a bell item and a push both need a real destination, and
 * a notification that opens nothing is the same broken promise as the two months
 * of silence this whole change exists to end.
 *
 * Open to every logged-in member: the list is `where user_id = auth.uid()` under
 * feedback_select, so it can only ever show you your own.
 */
export default async function FeedbackPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.user) redirect("/dashboard");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <MessagesSquare className="h-6 w-6" /> ฟีดแบคของฉัน
        </h1>
        <p className="text-sm text-muted-foreground">
          เรื่องที่คุณแจ้งเข้ามา และคำตอบจากทีมงาน
        </p>
      </div>
      <MyFeedbackList userId={ws.user.id} />
    </div>
  );
}
