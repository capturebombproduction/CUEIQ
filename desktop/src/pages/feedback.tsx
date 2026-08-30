// Desktop ฟีดแบคของฉัน — mirrors app/(app)/feedback/page.tsx and reuses
// MyFeedbackList verbatim.
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
import { MessagesSquare } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { MyFeedbackList } from "@/components/my-feedback-list";
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
