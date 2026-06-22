"use client";

import { useState } from "react";
import { Check, X, Loader2, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { notify } from "@/lib/notify-client";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { STATUS_META, type GroupStatus } from "@/lib/types";

// Approve / reject an event's setlist. The status badge is the TRIGGER: tap it to
// open a small dialog with อนุมัติ / ปฏิเสธ — so the schedule row stays clean
// (no inline ✓/✗ buttons crowding every show).
export function EventStatusActions({
  eventId,
  initialStatus,
  eventName,
}: {
  eventId: string;
  initialStatus: GroupStatus;
  eventName?: string;
}) {
  const [status, setStatus] = useState<GroupStatus>(initialStatus);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  async function set(next: GroupStatus) {
    if (next === status) {
      setOpen(false);
      return;
    }
    setBusy(true);
    const prev = status;
    setStatus(next);
    const { error } = await createClient()
      .from("events")
      .update({ status: next })
      .eq("id", eventId);
    setBusy(false);
    if (error) {
      toast.error("เปลี่ยนสถานะไม่สำเร็จ", { description: error.message });
      setStatus(prev);
    } else {
      toast.success(next === "approved" ? "อนุมัติแล้ว" : "ปฏิเสธแล้ว");
      notify(next === "approved" ? "event_approved" : "event_rejected", { eventId });
      setOpen(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="แตะเพื่อเปลี่ยนสถานะ (อนุมัติ / ปฏิเสธ)"
        className="inline-flex items-center gap-1 rounded-md transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        <StatusBadge status={status} />
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>เปลี่ยนสถานะงาน</DialogTitle>
            <DialogDescription>
              {eventName ? `“${eventName}” — ` : ""}สถานะตอนนี้คือ{" "}
              {STATUS_META[status].emoji} {STATUS_META[status].label}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              ยกเลิก
            </Button>
            <Button
              variant="destructive"
              onClick={() => set("rejected")}
              disabled={busy || status === "rejected"}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
              ปฏิเสธ
            </Button>
            <Button
              variant="success"
              onClick={() => set("approved")}
              disabled={busy || status === "approved"}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              อนุมัติ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
