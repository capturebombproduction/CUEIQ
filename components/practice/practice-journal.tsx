"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Trash2,
  Send,
  Lock,
  Users,
  Music4,
  CalendarDays,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  PRACTICE_CATEGORY_META,
  type Member,
  type PracticeAttendance,
  type PracticeCategory,
  type PracticeLog,
  type PracticeRun,
  type PracticeVisibility,
} from "@/lib/types";

const CATEGORIES: PracticeCategory[] = ["note", "problem", "summary", "homework"];

function bkkToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(
    new Date()
  );
}

function fmtDate(d: string) {
  try {
    return new Date(d + "T00:00:00").toLocaleDateString("th-TH", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

/**
 * Practice journal (Slice 3) — dated entries (note / problem / summary / homework)
 * with shared vs staff-only (Ar/ครู) visibility + per-member tagging, homework that
 * carries over until ticked, today's auto-logged songs, attendance (Ar), and a
 * history timeline. RLS enforces the real boundaries; the UI just mirrors them.
 */
export function PracticeJournal({
  eventId,
  groupId,
  tenantId,
  members,
  canManage,
  currentUserId,
  refreshSignal,
}: {
  eventId: string;
  groupId: string;
  tenantId: string;
  members: Member[];
  canManage: boolean;
  currentUserId: string;
  refreshSignal: number;
}) {
  const today = bkkToday();
  const confirm = useConfirm();
  const [logs, setLogs] = useState<PracticeLog[]>([]);
  const [runs, setRuns] = useState<PracticeRun[]>([]);
  const [attendance, setAttendance] = useState<PracticeAttendance[]>([]);
  const [loading, setLoading] = useState(true);

  // compose form
  const [category, setCategory] = useState<PracticeCategory>("note");
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<PracticeVisibility>("shared");
  const [targetMember, setTargetMember] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const memberName = useCallback(
    (id: string | null) => {
      if (!id) return null;
      const m = members.find((x) => x.id === id);
      return m ? m.nickname || m.name : null;
    },
    [members]
  );

  const load = useCallback(async () => {
    const supabase = createClient();
    const [lRes, rRes, aRes] = await Promise.all([
      supabase
        .from("practice_logs")
        .select("*")
        .eq("event_id", eventId)
        .order("log_date", { ascending: false })
        .order("created_at", { ascending: false }),
      supabase
        .from("practice_runs")
        .select("*")
        .eq("event_id", eventId)
        .eq("log_date", today),
      supabase
        .from("practice_attendance")
        .select("*")
        .eq("event_id", eventId)
        .eq("log_date", today),
    ]);
    setLogs((lRes.data ?? []) as PracticeLog[]);
    setRuns((rRes.data ?? []) as PracticeRun[]);
    setAttendance((aRes.data ?? []) as PracticeAttendance[]);
    setLoading(false);
  }, [eventId, today]);

  useEffect(() => {
    load();
  }, [load, refreshSignal]);

  async function addLog() {
    const text = body.trim();
    if (!text || saving) return;
    setSaving(true);
    const supabase = createClient();
    const vis: PracticeVisibility = canManage ? visibility : "shared";
    const { data, error } = await supabase
      .from("practice_logs")
      .insert({
        tenant_id: tenantId,
        group_id: groupId,
        event_id: eventId,
        author_id: currentUserId,
        visibility: vis,
        category,
        body: text,
        target_member_id: targetMember || null,
      })
      .select("*")
      .single();
    setSaving(false);
    if (error || !data) {
      toast.error("บันทึกไม่สำเร็จ", { description: error?.message });
      return;
    }
    setLogs((prev) => [data as PracticeLog, ...prev]);
    setBody("");
    setTargetMember("");
    toast.success("บันทึกแล้ว");
  }

  async function toggleDone(log: PracticeLog) {
    const next = !log.done;
    setLogs((prev) => prev.map((l) => (l.id === log.id ? { ...l, done: next } : l)));
    const supabase = createClient();
    const { error } = await supabase
      .from("practice_logs")
      .update({ done: next, updated_at: new Date().toISOString() })
      .eq("id", log.id);
    if (error) {
      setLogs((prev) => prev.map((l) => (l.id === log.id ? { ...l, done: !next } : l)));
      toast.error("อัปเดตไม่สำเร็จ");
    }
  }

  async function removeLog(id: string) {
    const ok = await confirm({
      title: "ลบบันทึกนี้?",
      description: "บันทึกการซ้อมรายการนี้จะถูกลบถาวร",
    });
    if (!ok) return;
    setLogs((prev) => prev.filter((l) => l.id !== id));
    const supabase = createClient();
    await supabase.from("practice_logs").delete().eq("id", id);
  }

  async function setPresent(memberId: string, present: boolean) {
    if (!canManage) return;
    // optimistic
    setAttendance((prev) => {
      const existing = prev.find((a) => a.member_id === memberId);
      if (existing) return prev.map((a) => (a.member_id === memberId ? { ...a, present } : a));
      return [
        ...prev,
        {
          id: `tmp-${memberId}`,
          tenant_id: tenantId,
          group_id: groupId,
          event_id: eventId,
          log_date: today,
          member_id: memberId,
          present,
          created_at: new Date().toISOString(),
        },
      ];
    });
    const supabase = createClient();
    await supabase.from("practice_attendance").upsert(
      {
        tenant_id: tenantId,
        group_id: groupId,
        event_id: eventId,
        log_date: today,
        member_id: memberId,
        present,
      },
      { onConflict: "event_id,log_date,member_id" }
    );
  }

  // --- derived views ---
  const outstandingHomework = useMemo(
    () => logs.filter((l) => l.category === "homework" && !l.done),
    [logs]
  );

  const runSummary = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of runs) {
      map.set(r.song_title, (map.get(r.song_title) ?? 0) + r.seconds);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [runs]);

  const byDate = useMemo(() => {
    const groups = new Map<string, PracticeLog[]>();
    for (const l of logs) {
      const arr = groups.get(l.log_date) ?? [];
      arr.push(l);
      groups.set(l.log_date, arr);
    }
    return Array.from(groups.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [logs]);

  const presentOf = (memberId: string) =>
    attendance.find((a) => a.member_id === memberId)?.present ?? false;

  if (loading) {
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* compose */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                category === c
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              )}
            >
              {PRACTICE_CATEGORY_META[c].emoji} {PRACTICE_CATEGORY_META[c].label}
            </button>
          ))}
        </div>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            category === "homework"
              ? "การบ้าน เช่น ฝึก Verse 2 ที่ 0.75x ให้คล่อง"
              : category === "problem"
                ? "ปัญหาที่เจอวันนี้..."
                : category === "summary"
                  ? "สรุปการซ้อมวันนี้..."
                  : "จดบันทึก..."
          }
          rows={3}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* member tag */}
          <select
            value={targetMember}
            onChange={(e) => setTargetMember(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="">เกี่ยวกับใคร (ไม่ระบุ)</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nickname || m.name}
              </option>
            ))}
          </select>

          {/* visibility — Ar only; members always post shared */}
          {canManage ? (
            <div className="flex overflow-hidden rounded-md border text-xs">
              <button
                onClick={() => setVisibility("shared")}
                className={cn(
                  "px-2.5 py-1.5 transition-colors",
                  visibility === "shared"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                )}
              >
                <Users className="mr-1 inline h-3.5 w-3.5" /> รวม
              </button>
              <button
                onClick={() => setVisibility("staff")}
                className={cn(
                  "px-2.5 py-1.5 transition-colors",
                  visibility === "staff"
                    ? "bg-amber-500 text-white"
                    : "text-muted-foreground hover:bg-muted"
                )}
              >
                <Lock className="mr-1 inline h-3.5 w-3.5" /> เฉพาะครู
              </button>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">
              <Users className="mr-1 inline h-3.5 w-3.5" /> เมมเบอร์เห็นได้
            </span>
          )}

          <Button
            className="ml-auto"
            size="sm"
            disabled={!body.trim() || saving}
            onClick={addLog}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            บันทึก
          </Button>
        </div>
      </div>

      {/* outstanding homework (carry over) */}
      {outstandingHomework.length > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="mb-2 text-sm font-semibold">📌 การบ้านค้าง</p>
          <div className="space-y-1.5">
            {outstandingHomework.map((l) => (
              <label key={l.id} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={l.done}
                  onChange={() => toggleDone(l)}
                  className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
                />
                <span className="flex-1">
                  {l.body}
                  {memberName(l.target_member_id) && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      · {memberName(l.target_member_id)}
                    </span>
                  )}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({fmtDate(l.log_date)})
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* today's auto-logged songs */}
      {runSummary.length > 0 && (
        <div className="rounded-xl border bg-card p-4">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Music4 className="h-4 w-4" /> ซ้อมวันนี้
          </p>
          <div className="flex flex-wrap gap-1.5">
            {runSummary.map(([title, secs]) => (
              <span key={title} className="rounded-full bg-muted px-2.5 py-1 text-xs">
                {title}
                <span className="ml-1 text-muted-foreground">
                  {Math.max(1, Math.round(secs / 60))} นาที
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* attendance (Ar only) */}
      {canManage && members.length > 0 && (
        <div className="rounded-xl border bg-card p-4">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Users className="h-4 w-4" /> เช็คชื่อวันนี้
          </p>
          <div className="flex flex-wrap gap-1.5">
            {members.map((m) => {
              const here = presentOf(m.id);
              return (
                <button
                  key={m.id}
                  onClick={() => setPresent(m.id, !here)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    here
                      ? "border-green-500 bg-green-500/15 text-green-700 dark:text-green-400"
                      : "text-muted-foreground hover:bg-muted"
                  )}
                >
                  {here ? "✓ " : ""}
                  {m.nickname || m.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* history */}
      {byDate.length === 0 ? (
        <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          ยังไม่มีบันทึกการซ้อม — เริ่มจดด้านบนได้เลย
        </div>
      ) : (
        <div className="space-y-4">
          {byDate.map(([date, entries]) => (
            <div key={date}>
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <CalendarDays className="h-3.5 w-3.5" />
                {fmtDate(date)}
                {date === today && (
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                    วันนี้
                  </span>
                )}
              </p>
              <div className="space-y-2">
                {entries.map((l) => {
                  const canEditThis = canManage || l.author_id === currentUserId;
                  return (
                    <div
                      key={l.id}
                      className={cn(
                        "rounded-lg border p-3",
                        l.visibility === "staff" && "border-amber-500/40 bg-amber-500/5"
                      )}
                    >
                      <div className="mb-1 flex items-center gap-1.5 text-xs">
                        <span className="font-medium">
                          {PRACTICE_CATEGORY_META[l.category].emoji}{" "}
                          {PRACTICE_CATEGORY_META[l.category].label}
                        </span>
                        {l.visibility === "staff" && (
                          <span className="flex items-center gap-0.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                            <Lock className="h-3 w-3" /> เฉพาะครู
                          </span>
                        )}
                        {memberName(l.target_member_id) && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                            {memberName(l.target_member_id)}
                          </span>
                        )}
                        {canEditThis && (
                          <button
                            onClick={() => removeLog(l.id)}
                            className="ml-auto text-muted-foreground hover:text-destructive"
                            title="ลบ"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      <p className="whitespace-pre-wrap text-sm">{l.body}</p>
                      {l.category === "homework" && (
                        <label className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={l.done}
                            onChange={() => toggleDone(l)}
                            className="h-3.5 w-3.5 accent-[var(--primary)]"
                          />
                          {l.done ? "เสร็จแล้ว" : "ยังไม่เสร็จ"}
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
