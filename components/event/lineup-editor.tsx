"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Users, CheckCheck, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { OFFLINE_QUEUED_MESSAGE, tryQueueChildList } from "@/lib/mgmt-write";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { lineupStatus, memberLabel } from "@/lib/lineup";
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
      <p className="rounded-[2px] border border-dashed py-8 text-center text-sm text-muted-foreground">
        วงนี้ยังไม่มีสมาชิก — เพิ่มสมาชิกที่หน้า “วง” ก่อน
      </p>
    );
  }

  // Who is missing, by name (the same words the run sheet prints — lib/lineup).
  const { chosen, absent } = lineupStatus(members, [...lineup]);

  return (
    <div className="space-y-3">
      <div className="well flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[2px] px-3 py-2 shadow-edge">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Users aria-hidden className="h-4 w-4 text-muted-foreground" />
          มางานนี้ <span className="num text-[17px]">{lineup.size}/{members.length}</span> คน
        </span>
        {chosen && absent.length > 0 && (
          <span className="chip chip-warning max-w-full">
            <Users aria-hidden />
            <span className="truncate">ขาด {absent.map(memberLabel).join(", ")}</span>
          </span>
        )}
        {editable && (
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="secondary" onClick={selectAll}>
              <CheckCheck aria-hidden className="h-4 w-4" /> เลือกทั้งหมด
            </Button>
            <Button type="button" variant="ghost" onClick={clearAll}>
              <X aria-hidden className="h-4 w-4" /> ล้าง
            </Button>
          </div>
        )}
      </div>

      {lineup.size === 0 && (
        <p className="text-[12.5px] text-muted-foreground">
          ยังไม่ได้เลือกใครมางานนี้ — แตะชื่อเพื่อเลือก หรือกด “เลือกทั้งหมด”
        </p>
      )}

      {/* One slab per member: the mic number in a tile ringed in the member's own
          colour (data, so an inline style), the names, and a present / absent
          switch. aria-pressed carries the state for assistive tech. */}
      <div className="stack">
        {members.map((m) => {
          const inLineup = lineup.has(m.id);
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => toggle(m.id)}
              disabled={!editable}
              aria-pressed={inLineup}
              className={cn(
                "slab flex min-h-[60px] w-full items-center gap-3 px-3 text-left transition-opacity",
                !inLineup && "opacity-60",
                !editable && "cursor-default"
              )}
            >
              <span
                className="num grid h-9 w-9 flex-none place-items-center rounded-[2px] bg-muted text-[15px]"
                style={{
                  boxShadow: `0 0 0 2px hsl(var(--card)), 0 0 0 4px ${m.color ?? "hsl(var(--border))"}`,
                }}
              >
                {m.mic_number ?? "—"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold">{m.nickname || m.name}</span>
                {m.nickname && (
                  <span className="block truncate text-[12px] text-muted-foreground">{m.name}</span>
                )}
              </span>
              <span className="flex flex-none items-center gap-2">
                <span className="text-[12.5px] text-muted-foreground">{inLineup ? "มา" : "ไม่มา"}</span>
                <span
                  aria-hidden
                  className={cn(
                    // A switch drawn in Tailwind (stage.css has no .switch yet): the
                    // knob in the ink that holds on its track in both themes.
                    "relative h-7 w-[46px] rounded-[2px] after:absolute after:top-[3px] after:h-[22px] after:w-[22px] after:rounded-[1px] after:content-['']",
                    inLineup
                      ? "bg-primary after:right-[3px] after:bg-primary-foreground"
                      : "bg-input after:left-[3px] after:bg-foreground/70"
                  )}
                />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
