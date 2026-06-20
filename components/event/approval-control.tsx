"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Send, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import type { GroupStatus } from "@/lib/types";

/**
 * Approval-lifecycle buttons on the event detail header, for the transitions the
 * completeness gate does NOT auto-manage:
 *  - APPROVED is locked → "แก้ไข (จะกลับไปรออนุมัติ)" reverts it to pending_review
 *    so it can be edited (and must be re-approved). Shown to the band's editor or
 *    an approver.
 *  - REJECTED → "ส่งขออนุมัติอีกครั้ง" lets the band's editor resubmit once the
 *    event is complete again.
 * draft ↔ pending_review is automatic (see EventWorkspace), so nothing here.
 */
export function ApprovalControl({
  eventId,
  status,
  canRevert,
  canResubmit,
}: {
  eventId: string;
  status: GroupStatus;
  canRevert: boolean; // approved → pending_review (editor or approver)
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
    router.refresh();
  }

  if (status === "approved" && canRevert) {
    return (
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => setStatus("pending_review", "ปลดล็อกแล้ว — กลับไปรออนุมัติ")}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
        แก้ไข (จะกลับไปรออนุมัติ)
      </Button>
    );
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
