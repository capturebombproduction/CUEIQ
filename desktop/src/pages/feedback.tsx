// Desktop Feedback — mirrors app/(app)/feedback/page.tsx and reuses
// MyFeedbackList and the Feedback tile (FeedbackButton) verbatim.
//
// WHY THIS FILE EXISTS AT ALL. /api/notify sends "ทีมงานตอบฟีดแบคของคุณแล้ว" with
// link "/feedback", and the bell navigates to whatever the row says. Without a
// route here the desktop's catch-all `<Route path="*">` would bounce that click
// silently to the dashboard — which is the same broken promise as the two months
// of silence this whole change exists to end, only faster and harder to notice.
//
// No cache read: an answer that only exists on the server cannot be shown offline,
// and MyFeedbackList already renders "กำลังโหลด…" rather than claiming the list is
// empty when the read fails (an empty read is not an empty table).
import { Card, CardContent } from "@/components/ui/card";
import { MyFeedbackList } from "@/components/my-feedback-list";
import { FeedbackButton } from "@/components/feedback-button";
import { PageTitle } from "@/components/page-title";
import { useWorkspace } from "~/data/workspace-context";

export function Feedback() {
  const { ws } = useWorkspace();

  if (!ws?.user) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          กำลังโหลด…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <PageTitle title="Feedback" />
        <p className="text-[14px] text-muted-foreground">
          เรื่องที่คุณแจ้งเข้ามา และคำตอบจากทีมงาน
        </p>
      </div>
      {/* The report form — the same tile the More sheet carries. It renders
          nothing without a tenant, exactly as it does there. */}
      <div className="sm:max-w-xs">
        <FeedbackButton userId={ws.user.id} tenantId={ws.membership?.tenant_id ?? null} />
      </div>
      <h2 className="h2 pt-2">Sent</h2>
      <MyFeedbackList userId={ws.user.id} />
    </div>
  );
}
