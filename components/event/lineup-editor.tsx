"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Users, CheckCheck, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { OFFLINE_QUEUED_MESSAGE, tryQueueChildList } from "@/lib/mgmt-write";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import type { Member } from "@/lib/types";

// Which band members are performing at THIS event. A row in event_members = in.
// Empty = not chosen yet (the UI nudges "select all"). See 0006_event_lineup.sql.
export function LineupEditor({
  eventId,
  tenantId,
  editable,
  members,
  initialLineup,
  eventName,
}: {
  eventId: string;
  tenantId: string;
  editable: boolean;
  members: Member[];
  initialLineup: string[];
  eventName?: string;
}) {
  const [lineup, setLineup] = useState<Set<string>>(new Set(initialLineup));
  const supabase = createClient();
  const confirm = useConfirm();

  // ⭐#1 step 5: a write that failed on a DEAD NETWORK queues the whole post-edit
  // member set as one offline snapshot and returns true — keep the optimistic
  // state. Web (no sink) / real rejections return false → original handling.
  async function queueOffline(
    next: Set<string>,
    base: Set<string>,
    errorMessage: string | null | undefined
  ): Promise<boolean> {
    const queued = await tryQueueChildList({
      kind: "lineup.upsert",
      eventId,
      tenantId,
      eventName,
      rows: Array.from(next),
      baseRows: Array.from(base),
      errorMessage: errorMessage ?? null,
    });
    if (queued) toast.success(OFFLINE_QUEUED_MESSAGE, { id: "mgmt-offline-queued" });
    return queued;
  }

  async function toggle(memberId: string) {
    if (!editable) return;
    const next = new Set(lineup);
    const wasIn = next.has(memberId);
    if (wasIn) next.delete(memberId);
    else next.add(memberId);
    setLineup(next);
    const { error } = wasIn
      ? await supabase
          .from("event_members")
          .delete()
          .eq("event_id", eventId)
          .eq("member_id", memberId)
      : await supabase
          .from("event_members")
          .insert({ tenant_id: tenantId, event_id: eventId, member_id: memberId });
    if (error) {
      if (await queueOffline(next, lineup, error.message)) return;
      toast.error("บันทึกไม่สำเร็จ", { description: error.message });
      setLineup(new Set(lineup)); // roll back
    }
  }

  async function selectAll() {
    if (!editable) return;
    const prev = new Set(lineup);
    setLineup(new Set(members.map((m) => m.id)));
    const rows = members
      .filter((m) => !prev.has(m.id))
      .map((m) => ({ tenant_id: tenantId, event_id: eventId, member_id: m.id }));
    if (rows.length === 0) return;
    const { error } = await supabase
      .from("event_members")
      .upsert(rows, { onConflict: "event_id,member_id", ignoreDuplicates: true });
    if (error) {
      if (await queueOffline(new Set(members.map((m) => m.id)), prev, error.message)) return;
      toast.error("เลือกทั้งหมดไม่สำเร็จ", { description: error.message });
      setLineup(prev);
    }
  }

  async function clearAll() {
    if (!editable) return;
    if (lineup.size === 0) return;
    const ok = await confirm({
      title: "ล้างรายชื่อทั้งหมด?",
      description: "จะเอาสมาชิกออกจากรายชื่อขึ้นแสดงของงานนี้ทั้งหมด (เลือกใหม่ได้)",
      confirmText: "ล้างทั้งหมด",
    });
    if (!ok) return;
    const prev = new Set(lineup);
    setLineup(new Set());
    const { error } = await supabase
      .from("event_members")
      .delete()
      .eq("event_id", eventId);
    if (error) {
      if (await queueOffline(new Set(), prev, error.message)) return;
      toast.error("ล้างไม่สำเร็จ", { description: error.message });
      setLineup(prev);
    }
  }

  if (members.length === 0) {
    return (
      <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
        วงนี้ยังไม่มีสมาชิก — เพิ่มสมาชิกที่หน้า “วง” ก่อน
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/30 px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Users className="h-4 w-4 text-muted-foreground" />
          มางานนี้ {lineup.size}/{members.length} คน
        </span>
        {editable && (
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={selectAll}>
              <CheckCheck className="h-3.5 w-3.5" /> เลือกทั้งหมด
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
              <X className="h-3.5 w-3.5" /> ล้าง
            </Button>
          </div>
        )}
      </div>

      {lineup.size === 0 && (
        <p className="text-xs text-muted-foreground">
          ยังไม่ได้เลือกใครมางานนี้ — แตะชื่อเพื่อเลือก หรือกด “เลือกทั้งหมด”
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {members.map((m) => {
          const inLineup = lineup.has(m.id);
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => toggle(m.id)}
              disabled={!editable}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition",
                inLineup
                  ? "border-primary bg-primary/10 font-medium"
                  : "text-muted-foreground opacity-70 hover:opacity-100",
                !editable && "cursor-default"
              )}
              style={
                inLineup && m.color ? { borderColor: m.color } : undefined
              }
            >
              {inLineup && <Check className="h-3.5 w-3.5 text-primary" />}
              {m.mic_number != null && (
                <span className="tabular-nums font-semibold">{m.mic_number}</span>
              )}
              {m.nickname || m.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
