"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { notify } from "@/lib/notify-client";
import { wroteNothing, noRowsMessage } from "@/lib/write-guard";
import { Button } from "@/components/ui/button";
import { STATUS_META, type GroupStatus } from "@/lib/types";

const knownStatus = (s: GroupStatus): GroupStatus =>
  Object.prototype.hasOwnProperty.call(STATUS_META, s) ? s : "draft";

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
    // Only over the status this page SHOWED (2026-10-27) - EventStatusActions' rule
    // since c4388cf. A page left open on "rejected" while staff approved the show
    // used to drag it back to รออนุมัติ, and page every approver about it.
    const { data, error } = await createClient()
      .from("events")
      .update({ status: next })
      .eq("id", eventId)
      .eq("status", status)
      .select("id");
    if (error) {
      setBusy(false);
      toast.error("เปลี่ยนสถานะไม่สำเร็จ", { description: error.message });
      return;
    }
    if (wroteNothing(data)) {
      // 0 rows with no error = never resubmitted — don't page the approvers over it.
      // Say WHY when it is the status that moved on (the update above was conditional),
      // in EventStatusActions' words, and bring the page up to what the row holds.
      const { data: row } = await createClient()
        .from("events")
        .select("status")
        .eq("id", eventId)
        .maybeSingle();
      setBusy(false);
      const nowStatus = (row as { status?: GroupStatus } | null)?.status;
      if (nowStatus === next) {
        // Already resubmitted - from another device, which told the approvers itself.
        toast.success(msg);
        router.refresh();
      } else if (nowStatus && nowStatus !== status) {
        toast.error("สถานะงานนี้เปลี่ยนไปแล้ว", {
          description: `ตอนนี้เป็น “${STATUS_META[knownStatus(nowStatus)].label}” — ดูให้แน่ใจก่อนแล้วค่อยเปลี่ยนอีกครั้ง`,
        });
        router.refresh();
      } else {
        toast.error(await noRowsMessage());
      }
      return;
    }
    setBusy(false);
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
