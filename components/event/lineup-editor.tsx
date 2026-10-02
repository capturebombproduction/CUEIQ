"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Users, CheckCheck, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { OFFLINE_QUEUED_MESSAGE, tryQueueChildList } from "@/lib/mgmt-write";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { SaveStatus, useSaveSignal } from "@/components/event/save-status";
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
  onChange,
}: {
  eventId: string;
  tenantId: string;
  editable: boolean;
  members: Member[];
  initialLineup: string[];
  eventName?: string;
  /** Tells the page who is in the lineup NOW, every time this editor's own list
   *  moves: the optimistic edit and, if its write is refused, the rollback. The
   *  Mics tab reads who is performing from the page, not from in here — it used to
   *  read the lineup the page LOADED with, so a member taken off here still held a
   *  mic there (EventWorkspace keeps the one live copy). */
  onChange?: (lineup: string[]) => void;
}) {
  const [lineup, setLineup] = useState<Set<string>>(new Set(initialLineup));
  const supabase = createClient();
  const confirm = useConfirm();
  // The same receipt and the same pending count the setlist / schedule / mic editors keep
  // (components/event/save-status.tsx -> lib/dirty-guard.ts): "บันทึก / อัปเดต" and the Summary
  // switch refresh the page only once nothing is pending, and a lineup write on the wire used
  // to be invisible to that - the refresh could read the half-saved list and re-seed the
  // Lineup panel and the Mics tab from it.
  const save = useSaveSignal();
  /** One lineup write, reported begin -> end. A dead network queues the post-edit set
   *  offline (queued IS saved: it is on disk and will flush); anything else that failed
   *  rolls back to `rollback`. A fetch that throws is a failure too, never a stuck "saving". */
  async function write(
    run: () => PromiseLike<{ error: { message: string } | null }>,
    next: Set<string>,
    rollback: Set<string>,
    failTitle: string
  ) {
    save.begin();
    let error: { message: string } | null;
    try {
      ({ error } = await run());
    } catch (e) {
      error = { message: e instanceof Error ? e.message : String(e) };
    }
    if (!error) {
      save.end(true);
      return;
    }
    if (await queueOffline(next, rollback, error.message)) {
      save.end(true);
      return;
    }
    save.end(false);
    toast.error(failTitle, { description: error.message });
    commit(new Set(rollback));
  }

  // Every move of the list goes through here, so the page can never be told less
  // than the screen shows. (The parent's setter is called out here, not inside a
  // state updater.) A write that settles after this editor was replaced — the page
  // re-seeds a hidden Lineup panel when the server's list changes — must not speak
  // for it any more: its late rollback would put the page back on a list the new
  // panel was never given.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function commit(next: Set<string>) {
    setLineup(next);
    if (alive.current) onChange?.([...next]);
  }

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
    commit(next);
    await write(
      () =>
        wasIn
          ? supabase.from("event_members").delete().eq("event_id", eventId).eq("member_id", memberId)
          : supabase.from("event_members").insert({ tenant_id: tenantId, event_id: eventId, member_id: memberId }),
      next,
      lineup,
      "บันทึกไม่สำเร็จ"
    );
  }

  async function selectAll() {
    if (!editable) return;
    const prev = new Set(lineup);
    commit(new Set(members.map((m) => m.id)));
    const rows = members
      .filter((m) => !prev.has(m.id))
      .map((m) => ({ tenant_id: tenantId, event_id: eventId, member_id: m.id }));
    if (rows.length === 0) return;
    await write(
      () => supabase.from("event_members").upsert(rows, { onConflict: "event_id,member_id", ignoreDuplicates: true }),
      new Set(members.map((m) => m.id)),
      prev,
      "เลือกทั้งหมดไม่สำเร็จ"
    );
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
    commit(new Set());
    await write(() => supabase.from("event_members").delete().eq("event_id", eventId), new Set(), prev, "ล้างไม่สำเร็จ");
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
        {editable && <SaveStatus state={save.state} className="text-[12.5px]" />}
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
                  // The third shadow is a neutral hairline just outside the member's
                  // colour: a pale colour (#efefef, #ffff00) on a light card or a
                  // near-black one (#434343) on a dark card is otherwise no edge at all.
                  // (No colour → the ring is already the border colour.)
                  boxShadow: `0 0 0 2px hsl(var(--card)), 0 0 0 4px ${m.color ?? "hsl(var(--border))"}${
                    m.color ? ", 0 0 0 5px hsl(var(--border))" : ""
                  }`,
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
