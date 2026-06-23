"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, ChevronUp, ChevronDown, Mic2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Member, MicAssignment, SetlistItem } from "@/lib/types";

export function MicMapEditor({
  eventId,
  tenantId,
  editable,
  initialMics,
  members,
  setlist,
}: {
  eventId: string;
  tenantId: string;
  editable: boolean;
  initialMics: MicAssignment[];
  members: Member[];
  setlist: SetlistItem[];
}) {
  const supabase = createClient();
  const confirm = useConfirm();
  const [mics, setMics] = useState<MicAssignment[]>(initialMics);

  // Group holders by mic number (rotation order within each).
  const groups = useMemo(() => {
    const map = new Map<number, MicAssignment[]>();
    for (const m of mics) {
      const arr = map.get(m.mic_number) ?? [];
      arr.push(m);
      map.set(m.mic_number, arr);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([num, holders]) => ({
        num,
        holders: holders.sort((a, b) => a.order_index - b.order_index),
      }));
  }, [mics]);

  async function persist(id: string, partial: Partial<MicAssignment>) {
    const { error } = await supabase
      .from("mic_assignments")
      .update(partial)
      .eq("id", id);
    if (error) toast.error("บันทึกไม่สำเร็จ", { description: error.message });
  }

  async function addMic() {
    const nextNum = groups.length ? Math.max(...groups.map((g) => g.num)) + 1 : 1;
    const { data, error } = await supabase
      .from("mic_assignments")
      .insert({
        tenant_id: tenantId,
        event_id: eventId,
        mic_number: nextNum,
        holder_name: "",
        order_index: 1,
      })
      .select("*")
      .single();
    if (error || !data) {
      toast.error("เพิ่มไมค์ไม่สำเร็จ", { description: error?.message });
      return;
    }
    setMics((prev) => [...prev, data as MicAssignment]);
  }

  async function addHolder(micNumber: number, name = "") {
    const inGroup = mics.filter((m) => m.mic_number === micNumber);
    const order = inGroup.length
      ? Math.max(...inGroup.map((m) => m.order_index)) + 1
      : 1;
    const { data, error } = await supabase
      .from("mic_assignments")
      .insert({
        tenant_id: tenantId,
        event_id: eventId,
        mic_number: micNumber,
        holder_name: name,
        order_index: order,
      })
      .select("*")
      .single();
    if (error || !data) {
      toast.error("เพิ่มคนไม่สำเร็จ", { description: error?.message });
      return;
    }
    setMics((prev) => [...prev, data as MicAssignment]);
  }

  async function removeHolder(id: string) {
    const holder = mics.find((m) => m.id === id);
    const ok = await confirm({
      title: "เอาคนนี้ออกจากไมค์?",
      description: holder?.holder_name
        ? `“${holder.holder_name}” จะถูกเอาออกจากไมค์ #${holder.mic_number}`
        : "ผู้ถือไมค์คนนี้จะถูกเอาออก",
    });
    if (!ok) return;
    const snapshot = mics;
    setMics((prev) => prev.filter((m) => m.id !== id));
    const { error } = await supabase
      .from("mic_assignments")
      .delete()
      .eq("id", id);
    if (error) {
      toast.error("ลบไม่สำเร็จ", { description: error.message });
      setMics(snapshot);
    }
  }

  async function removeMic(micNumber: number) {
    const ok = await confirm({
      title: `ลบไมค์ #${micNumber}?`,
      description: "ผู้ถือไมค์ทุกคนในไมค์นี้จะถูกเอาออก",
    });
    if (!ok) return;
    const snapshot = mics;
    setMics((prev) => prev.filter((m) => m.mic_number !== micNumber));
    const { error } = await supabase
      .from("mic_assignments")
      .delete()
      .eq("event_id", eventId)
      .eq("mic_number", micNumber);
    if (error) {
      toast.error("ลบไม่สำเร็จ", { description: error.message });
      setMics(snapshot);
    }
  }

  /** Returns true if applied, false if rejected (caller should revert the input). */
  function changeMicNumber(oldNum: number, newNum: number): boolean {
    if (newNum === oldNum) return true; // unchanged — keep as-is
    if (!Number.isFinite(newNum) || newNum < 1) return false;
    // don't silently merge into an existing mic group (would collide order_index)
    if (mics.some((m) => m.mic_number === newNum)) {
      toast.error(`ไมค์ ${newNum} มีอยู่แล้ว`, {
        description: "เลือกเบอร์อื่น หรือย้ายคนเข้ากลุ่มทีละคนแทน",
      });
      return false;
    }
    setMics((prev) =>
      prev.map((m) => (m.mic_number === oldNum ? { ...m, mic_number: newNum } : m))
    );
    supabase
      .from("mic_assignments")
      .update({ mic_number: newNum })
      .eq("event_id", eventId)
      .eq("mic_number", oldNum)
      .then(({ error }) => {
        if (error)
          toast.error("เปลี่ยนเบอร์ไมค์ไม่สำเร็จ", { description: error.message });
      });
    return true;
  }

  async function moveHolder(micNumber: number, index: number, dir: -1 | 1) {
    const group = groups.find((g) => g.num === micNumber);
    if (!group) return;
    const target = index + dir;
    if (target < 0 || target >= group.holders.length) return;
    const a = group.holders[index];
    const b = group.holders[target];
    setMics((prev) =>
      prev.map((m) => {
        if (m.id === a.id) return { ...m, order_index: b.order_index };
        if (m.id === b.id) return { ...m, order_index: a.order_index };
        return m;
      })
    );
    await Promise.all([
      supabase
        .from("mic_assignments")
        .update({ order_index: b.order_index })
        .eq("id", a.id),
      supabase
        .from("mic_assignments")
        .update({ order_index: a.order_index })
        .eq("id", b.id),
    ]);
  }

  const songsWithMics = setlist.filter((s) => (s.mic_slots?.length ?? 0) > 0);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* Base mic map */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mic2 className="h-5 w-5" /> Mic Map (ไมค์ → สมาชิก)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {members.length > 0 && (
            <datalist id="member-names">
              {members.map((m) => (
                <option key={m.id} value={m.nickname || m.name} />
              ))}
            </datalist>
          )}

          {groups.length === 0 && (
            <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              ยังไม่มีการกำหนดไมค์
            </p>
          )}

          {groups.map((g) => (
            <div key={g.num} className="rounded-lg border p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm text-muted-foreground">ไมค์</span>
                <Input
                  key={`mic-${g.num}`}
                  type="number"
                  min={1}
                  defaultValue={g.num}
                  disabled={!editable}
                  className="h-8 w-16 tabular-nums"
                  onBlur={(e) => {
                    if (!changeMicNumber(g.num, Number(e.target.value))) {
                      e.target.value = String(g.num); // revert on rejection
                    }
                  }}
                />
                {g.holders.length > 1 && (
                  <Badge variant="secondary">วนไมค์ {g.holders.length} คน</Badge>
                )}
                {editable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="ml-auto text-destructive hover:text-destructive"
                    onClick={() => removeMic(g.num)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <div className="space-y-2">
                {g.holders.map((h, i) => (
                  <div key={h.id} className="flex items-center gap-2">
                    {g.holders.length > 1 && (
                      <span className="w-5 text-center text-xs text-muted-foreground tabular-nums">
                        {i + 1}
                      </span>
                    )}
                    <Input
                      list="member-names"
                      value={h.holder_name}
                      disabled={!editable}
                      placeholder="ชื่อสมาชิก"
                      onChange={(e) =>
                        setMics((prev) =>
                          prev.map((m) =>
                            m.id === h.id
                              ? { ...m, holder_name: e.target.value }
                              : m
                          )
                        )
                      }
                      onBlur={(e) =>
                        persist(h.id, { holder_name: e.target.value })
                      }
                    />
                    {editable && (
                      <>
                        {g.holders.length > 1 && (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => moveHolder(g.num, i, -1)}
                              disabled={i === 0}
                            >
                              <ChevronUp className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => moveHolder(g.num, i, 1)}
                              disabled={i === g.holders.length - 1}
                            >
                              <ChevronDown className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          onClick={() => removeHolder(h.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </div>
                ))}
                {editable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => addHolder(g.num)}
                  >
                    <Plus className="h-4 w-4" /> เพิ่มคน (วนไมค์)
                  </Button>
                )}
              </div>
            </div>
          ))}

          {editable && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={addMic}
            >
              <Plus className="h-4 w-4" /> เพิ่มไมค์
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Per-song summary (derived from setlist) */}
      <Card>
        <CardHeader>
          <CardTitle>สรุป Mic Map แยกตามเพลง</CardTitle>
        </CardHeader>
        <CardContent>
          {songsWithMics.length === 0 ? (
            <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              ยังไม่ได้กำหนดไมค์ในเซ็ตลิสต์ — ตั้งค่าได้ที่แท็บ Setlist
            </p>
          ) : (
            <div className="space-y-3">
              {songsWithMics.map((s) => (
                <div key={s.id} className="rounded-lg border p-3">
                  <p className="mb-1.5 font-medium">{s.title}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {s.mic_slots.map((slot, i) => (
                      <Badge key={i} variant="outline" className="font-normal">
                        <span className="font-semibold">{slot.mic}</span>
                        <span className="mx-1 text-muted-foreground">→</span>
                        {slot.member}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
