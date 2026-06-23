"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, ArrowUp, ArrowDown, Download } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";

export type RunSequence = {
  id: string;
  tenant_id: string;
  event_name: string;
  event_date: string | null;
  sort_order: number;
  title: string;
  kind: string;
  planned_start: string | null; // "HH:MM[:SS]"
  planned_end: string | null;
  buffer_seconds: number;
  linked_event_id: string | null;
};

export type RunBandEvent = {
  id: string;
  group_name: string;
  stage_start: string | null; // "HH:MM:SS"
  stage_end: string | null;
};

// The kinds a running-order line can be — a band slot, a game, a ceremony, MC, a
// break, or anything else. Drives the Phase-2 live caller's colour/grouping later.
const KINDS: { value: string; label: string }[] = [
  { value: "band", label: "วง (Band)" },
  { value: "game", label: "เกม/กิจกรรม" },
  { value: "ceremony", label: "พิธี" },
  { value: "mc", label: "MC" },
  { value: "break", label: "Break" },
  { value: "other", label: "อื่นๆ" },
];

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : "");
const selCls = "rounded-md border bg-background px-2 py-1.5 text-sm";

/**
 * Builds the festival-wide running order (run_sequence rows) the staff will run live
 * in Phase 2. Autosaves each field like the setlist/staff-contacts editors; reorder
 * by swapping sort_order with the neighbour. "นำเข้าจากเวทีวง" seeds a band line per
 * stage slot so the staff don't retype the line-up.
 */
export function RunOrderBuilder({
  tenantId,
  eventName,
  eventDate,
  initial,
  bandEvents,
}: {
  tenantId: string;
  eventName: string;
  eventDate: string | null;
  initial: RunSequence[];
  bandEvents: RunBandEvent[];
}) {
  const supabase = createClient();
  const confirm = useConfirm();
  const [rows, setRows] = useState<RunSequence[]>(initial);
  const [busy, setBusy] = useState(false);

  function setLocal(id: string, partial: Partial<RunSequence>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...partial } : r)));
  }
  async function persist(id: string, partial: Partial<RunSequence>) {
    const { error } = await supabase.from("run_sequence").update(partial).eq("id", id);
    if (error) toast.error("บันทึกไม่สำเร็จ", { description: error.message });
  }
  function update(id: string, partial: Partial<RunSequence>) {
    setLocal(id, partial);
    persist(id, partial);
  }

  async function addRow() {
    setBusy(true);
    const sort = rows.length ? Math.max(...rows.map((r) => r.sort_order)) + 1 : 1;
    const { data, error } = await supabase
      .from("run_sequence")
      .insert({
        tenant_id: tenantId,
        event_name: eventName,
        event_date: eventDate,
        sort_order: sort,
        title: "",
        kind: "other",
      })
      .select("*")
      .single();
    setBusy(false);
    if (error || !data) {
      toast.error("เพิ่มไม่สำเร็จ", { description: error?.message });
      return;
    }
    setRows((prev) => [...prev, data as RunSequence]);
  }

  async function removeRow(id: string) {
    const ok = await confirm({
      title: "ลบลำดับนี้?",
      description: "แถวนี้จะถูกลบออกจาก running order",
    });
    if (!ok) return;
    const snap = rows;
    setRows((prev) => prev.filter((r) => r.id !== id));
    const { error } = await supabase.from("run_sequence").delete().eq("id", id);
    if (error) {
      toast.error("ลบไม่สำเร็จ", { description: error.message });
      setRows(snap);
    }
  }

  // Reorder by swapping sort_order with the neighbour (same trick the rest of the app
  // uses — no full re-index needed).
  async function move(id: string, dir: -1 | 1) {
    const sorted = [...rows].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sorted.findIndex((r) => r.id === id);
    const j = idx + dir;
    if (j < 0 || j >= sorted.length) return;
    const a = sorted[idx];
    const b = sorted[j];
    setRows((prev) =>
      prev.map((r) =>
        r.id === a.id
          ? { ...r, sort_order: b.sort_order }
          : r.id === b.id
            ? { ...r, sort_order: a.sort_order }
            : r
      )
    );
    await Promise.all([
      supabase.from("run_sequence").update({ sort_order: b.sort_order }).eq("id", a.id),
      supabase.from("run_sequence").update({ sort_order: a.sort_order }).eq("id", b.id),
    ]);
  }

  // Seed a band line per stage slot not already on the order, in stage-time order.
  async function importBands() {
    const linked = new Set(rows.map((r) => r.linked_event_id).filter(Boolean));
    const todo = bandEvents
      .filter((b) => b.stage_start && !linked.has(b.id))
      .sort((x, y) => (x.stage_start! < y.stage_start! ? -1 : 1));
    if (todo.length === 0) {
      toast.info("วงทุกวงถูกเพิ่มแล้ว (หรือยังไม่มีเวลาเวที)");
      return;
    }
    setBusy(true);
    let sort = rows.length ? Math.max(...rows.map((r) => r.sort_order)) : 0;
    const created: RunSequence[] = [];
    for (const b of todo) {
      sort += 1;
      const { data } = await supabase
        .from("run_sequence")
        .insert({
          tenant_id: tenantId,
          event_name: eventName,
          event_date: eventDate,
          sort_order: sort,
          title: b.group_name,
          kind: "band",
          planned_start: b.stage_start,
          planned_end: b.stage_end,
          linked_event_id: b.id,
        })
        .select("*")
        .single();
      if (data) created.push(data as RunSequence);
    }
    setBusy(false);
    setRows((prev) => [...prev, ...created]);
    toast.success(`เพิ่ม ${created.length} วงจากเวที`);
  }

  const ordered = [...rows].sort((a, b) => a.sort_order - b.sort_order);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={importBands} disabled={busy}>
          <Download className="h-4 w-4" /> นำเข้าจากเวทีวง
        </Button>
        <Button size="sm" onClick={addRow} disabled={busy}>
          <Plus className="h-4 w-4" /> เพิ่มลำดับ
        </Button>
      </div>

      {ordered.length === 0 ? (
        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          ยังไม่มีลำดับงาน — กด “นำเข้าจากเวทีวง” หรือ “เพิ่มลำดับ”
        </p>
      ) : (
        <div className="space-y-2">
          {ordered.map((r, i) => (
            <div key={r.id} className="rounded-lg border bg-card p-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => move(r.id, -1)}
                    disabled={i === 0}
                    className="text-muted-foreground disabled:opacity-30"
                    aria-label="เลื่อนขึ้น"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(r.id, 1)}
                    disabled={i === ordered.length - 1}
                    className="text-muted-foreground disabled:opacity-30"
                    aria-label="เลื่อนลง"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </div>
                <Input
                  type="time"
                  value={hhmm(r.planned_start)}
                  className="w-[7.5rem] shrink-0"
                  onChange={(e) => update(r.id, { planned_start: e.target.value || null })}
                />
                <span className="text-muted-foreground">–</span>
                <Input
                  type="time"
                  value={hhmm(r.planned_end)}
                  className="w-[7.5rem] shrink-0"
                  onChange={(e) => update(r.id, { planned_end: e.target.value || null })}
                />
                <select
                  value={r.kind}
                  onChange={(e) => update(r.id, { kind: e.target.value })}
                  className={selCls}
                >
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <Input
                  value={r.title}
                  placeholder="ชื่อลำดับ (เช่น Opening / Show Match)"
                  className="min-w-[160px] flex-1"
                  onChange={(e) => setLocal(r.id, { title: e.target.value })}
                  onBlur={(e) => persist(r.id, { title: e.target.value })}
                />
                <select
                  value={r.linked_event_id ?? ""}
                  onChange={(e) => update(r.id, { linked_event_id: e.target.value || null })}
                  className={selCls}
                  title="ผูกกับวง (ดึงเวลา/เปิด setlist)"
                >
                  <option value="">— ไม่ผูกวง —</option>
                  {bandEvents.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.group_name}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  buffer
                  <Input
                    type="number"
                    min={0}
                    value={Math.round((r.buffer_seconds || 0) / 60)}
                    className="w-16"
                    onChange={(e) =>
                      update(r.id, {
                        buffer_seconds: Math.max(0, Number(e.target.value) || 0) * 60,
                      })
                    }
                  />
                  น.
                </label>
                <button
                  type="button"
                  onClick={() => removeRow(r.id)}
                  className="ml-auto text-destructive"
                  aria-label="ลบ"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
