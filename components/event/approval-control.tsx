"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { notify } from "@/lib/notify-client";
import { Button } from "@/components/ui/button";
import type { GroupStatus } from "@/lib/types";

/**
 * Approval-lifecycle button on the event detail header. Editing is no longer gated
 * by approval (a band edits any time — approval is just a staff completeness badge),
 * so an approved event needs no "unlock". The only explicit transition left here is:
 *  - REJECTED → "ส่งขออนุมัติอีกครั้ง": the band's editor resubmits once the event
 *    is complete again.
 * draft ↔ pending_review is automatic (see EventWorkspace); approve/reject is the
 * staff action on the Overview (EventStatusActions).
 */
export function ApprovalControl({
  eventId,
  status,
  canResubmit,
}: {
  eventId: string;
  status: GroupStatus;
  canResubmit: boolean; // rejected → pending_review (editor, when complete)
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function setStatus(next: GroupStatus, msg: string) {
    setBusy(true);
    const { error } = await createClient()
      .from("events")
      .update({ status: next })
      .eq("id", eventId);
    setBusy(false);
    if (error) {
      toast.error("เปลี่ยนสถานะไม่สำเร็จ", { description: error.message });
      return;
    }
    toast.success(msg);
    // resubmit/revert both land on pending_review → ping the approvers
    if (next === "pending_review") notify("event_submitted", { eventId });
    router.refresh();
  }

  if (status === "rejected" && canResubmit) {
    return (
      <Button
        variant="default"
        disabled={busy}
        onClick={() => setStatus("pending_review", "ส่งขออนุมัติอีกครั้งแล้ว 🟠")}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        ส่งขออนุมัติอีกครั้ง
      </Button>
    );
  }

  return null;
}
