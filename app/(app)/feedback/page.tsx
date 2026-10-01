import { redirect } from "next/navigation";
import { getWorkspace } from "@/lib/queries";
import { MyFeedbackList } from "@/components/my-feedback-list";
import { FeedbackButton } from "@/components/feedback-button";
import { PageTitle } from "@/components/page-title";

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
 *
 * Writing a new one: the very Feedback tile the More sheet carries (its dialog is
 * the one report form, with the page + build attached) — never a floating button.
 */
export default async function FeedbackPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.user) redirect("/dashboard");

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <PageTitle title="Feedback" />
        <p className="text-[14px] text-muted-foreground">
          เรื่องที่คุณแจ้งเข้ามา และคำตอบจากทีมงาน
        </p>
      </div>
      <div className="sm:max-w-xs">
        <FeedbackButton userId={ws.user.id} tenantId={ws.membership.tenant_id} />
      </div>
      <h2 className="h2 pt-2">Sent</h2>
      <MyFeedbackList userId={ws.user.id} />
    </div>
  );
}
