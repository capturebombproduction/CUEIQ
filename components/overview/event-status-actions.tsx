"use client";

import { useState } from "react";
import { Check, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { notify } from "@/lib/notify-client";
import { StatusBadge } from "@/components/status-badge";
import type { GroupStatus } from "@/lib/types";

// Approve / reject an event's setlist straight from the label overview.
export function EventStatusActions({
  eventId,
  initialStatus,
}: {
  eventId: string;
  initialStatus: GroupStatus;
}) {
  const [status, setStatus] = useState<GroupStatus>(initialStatus);
  const [busy, setBusy] = useState(false);

  async function set(next: GroupStatus) {
    if (next === status) return;
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
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <StatusBadge status={status} />
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <>
          <button
            type="button"
            onClick={() => set("approved")}
            title="อนุมัติ"
            className="flex h-6 w-6 items-center justify-center rounded text-success hover:bg-muted"
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => set("rejected")}
            title="ปฏิเสธ"
            className="flex h-6 w-6 items-center justify-center rounded text-destructive hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );
}
