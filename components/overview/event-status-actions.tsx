"use client";

import { useState } from "react";
import { Check, X, Loader2, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { notify } from "@/lib/notify-client";
import { wroteNothing, noRowsMessage } from "@/lib/write-guard";
import { StatusBadge, StatusIcon } from "@/components/status-badge";
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

const knownStatus = (s: GroupStatus): GroupStatus =>
  Object.prototype.hasOwnProperty.call(STATUS_META, s) ? s : "draft";

// Approve / reject an event's setlist. The status badge is the TRIGGER: tap it to
// open a small dialog with อนุมัติ / ปฏิเสธ — so the schedule row stays clean
// (no inline ✓/✗ buttons crowding every show).
export function EventStatusActions({
  eventId,
  initialStatus,
  eventName,
  onChanged,
  trigger = "badge",
}: {
  eventId: string;
  initialStatus: GroupStatus;
  eventName?: string;
  /** "badge" (the board: the status pill IS the button, rows stay clean) or
   *  "button" (the event page: a plain อนุมัติ / ปฏิเสธ button for someone who
   *  arrived from a "มีงานรออนุมัติ" reminder and should not have to guess). */
  trigger?: "badge" | "button";
  /** Fired ONLY after a write that actually landed, so a parent counting these
   *  (the Overview's "รออนุมัติ N" chip) can never show a number that a failed or
   *  zero-row update invented. Deliberately not called on the optimistic set or
   *  the revert — see the branches below. */
  onChanged?: (next: GroupStatus) => void;
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
    const { data, error } = await createClient()
      .from("events")
      .update({ status: next })
      .eq("id", eventId)
      .select("id");
    setBusy(false);
    if (error) {
      toast.error("เปลี่ยนสถานะไม่สำเร็จ", { description: error.message });
      setStatus(prev);
    } else if (wroteNothing(data)) {
      // 0 rows with no error = the write never landed — don't tell the band it did.
      toast.error(await noRowsMessage());
      setStatus(prev);
    } else {
      toast.success(next === "approved" ? "อนุมัติแล้ว" : "ปฏิเสธแล้ว");
      notify(next === "approved" ? "event_approved" : "event_rejected", { eventId });
      onChanged?.(next);
      setOpen(false);
    }
  }

  return (
    <>
      {trigger === "button" ? (
        <Button variant="success" onClick={() => setOpen(true)} disabled={busy}>
          <Check className="h-4 w-4" /> อนุมัติ / ปฏิเสธ
        </Button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="แตะเพื่อเปลี่ยนสถานะ (อนุมัติ / ปฏิเสธ)"
          // A status chip you can tap: 44 px tall on a phone (the chip itself stays
          // chip-sized inside it), back to the chip's own height under a pointer.
          // `relative` keeps it above a neighbouring link's enlarged tap box.
          className="relative inline-flex min-h-11 items-center gap-1 rounded-[2px] transition-opacity duration-2 hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 sm:min-h-0"
        >
          <StatusBadge status={status} />
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        </button>
      )}

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change status</DialogTitle>
            <DialogDescription>
              {eventName ? `“${eventName}” — ` : ""}สถานะตอนนี้คือ{" "}
              <span className="inline-flex items-center gap-1 align-bottom">
                <StatusIcon status={status} className="h-3.5 w-3.5 shrink-0" />
                {/* an unknown status from the DB reads as Draft, as the chip that opened this does */}
                {STATUS_META[knownStatus(status)].label}
              </span>
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              ยกเลิก
            </Button>
            {/* Outline, not a red fill: a rejection is reversible (approve it again
                from the same chip), and solid red is kept for the moment of no return
                inside the confirm sheet (lib/destructive-fill.test.ts). */}
            <Button
              variant="destructive-outline"
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
