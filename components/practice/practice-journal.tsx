"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Trash2,
  Send,
  Lock,
  Users,
  Music4,
  CalendarDays,
  Eye,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";
import { wroteNothing, noRowsMessage } from "@/lib/write-guard";
import {
  canWriteJournal,
  canModifyLog,
  membershipFromProbe,
  membershipFromRefusal,
  isRlsRefusal,
  writeFailureMessage,
  type BandMembership,
} from "@/lib/practice-journal-gate";
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
 * The single place a failed write on this screen turns into words.
 *
 * All four writes here (addLog / toggleDone / removeLog / setPresent) used to
 * pass `error.message` straight into a Thai toast, which is how a member ticking
 * their own homework came to read `permission denied for table practice_logs`.
 * The English text is kept — but sent to the console, where โจเซฟิน looks and the
 * band does not.
 *
 * `signedIn` is threaded in when the caller already asked (addLog needs the same
 * answer to decide a membership verdict) so one failure never costs two
 * getSession() round trips.
 */
async function writeFailureNote(
  error: { code?: string | null; message?: string | null } | null | undefined,
  signedIn?: boolean
): Promise<string> {
  const live = signedIn ?? (await hasLiveSession());
  console.error(
    "[CueIQ] practice journal write failed:",
    error?.code ?? "-",
    error?.message ?? "-"
  );
  return writeFailureMessage(error?.code, error?.message, live);
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
  const [loadError, setLoadError] = useState(false);
  // latest state for load()'s "did this refetch just go blank" check below — load()
  // is a stable useCallback (deps: eventId/today only) so reading logs/runs/attendance
  // directly would see whatever they were the render load() was created in, not now
  const logsRef = useRef(logs);
  logsRef.current = logs;
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const attendanceRef = useRef(attendance);
  attendanceRef.current = attendance;

  // compose form
  const [category, setCategory] = useState<PracticeCategory>("note");
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<PracticeVisibility>("shared");
  const [targetMember, setTargetMember] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // Writing in a band's สมุดซ้อม is a BAND activity. Migration 0041 rescoped
  // practice_logs_insert from can_view_group to `can_edit_group OR a group_roles
  // row for this band`, because can_view_group is true for every label-wide role
  // and a read-only CEO could otherwise author notes in all 8 bands' rooms. The
  // composer below was never told: a CEO typed a note, pressed บันทึก, and got
  // the raw English PostgREST policy text as the description of a Thai error
  // toast. canManage (= canEditGroup) cannot be the gate on its own — it is
  // false for plain members too — so ask the same question the policy asks:
  // does this user hold a role IN this band?
  //
  // This is deliberately the SAME probe practice-mode.tsx runs for the player
  // half (its `canCurate`), and both now end it with membershipFromProbe, so one
  // probe result can no longer produce two opposite verdicts on the same screen.
  // (It could: the player half used to do `setInThisBand(data.length > 0)`, which
  // reads an anon-fallback empty answer as "not a member" and failed CLOSED.)
  // They stay two reads rather than one because Radix unmounts the inactive tab —
  // this probe only fires when สมุดซ้อม is opened, and hoisting it into the parent
  // would mean plumbing the answer back down for no change in behaviour.
  //
  // Unknown (in flight / offline / an unsigned read) keeps the composer — a member
  // at a venue must never be locked out of their own journal by a failed
  // membership read. RLS stays the real boundary, and addLog below feeds its
  // verdict back into `membership` when the policy refuses a write.
  const [membership, setMembership] = useState<BandMembership>("unknown");
  useEffect(() => {
    if (canManage) return; // admin / this band's Ar — already an editor
    let alive = true;
    (async () => {
      const { data, error } = await createClient()
        .from("group_roles")
        .select("role")
        .eq("group_id", groupId)
        .eq("user_id", currentUserId);
      if (!alive) return;
      // `data: [], error: null` is ALSO what RLS answers an anon request with,
      // and supabase-js falls back to the anon key for ~a minute after a failed
      // token refresh — so only believe an empty answer that went out signed.
      const rows = error || !data ? null : data.length;
      const signedIn = rows === 0 ? await hasLiveSession() : true;
      if (!alive) return;
      setMembership(membershipFromProbe(rows, signedIn));
    })();
    return () => {
      alive = false;
    };
  }, [groupId, currentUserId, canManage]);

  // May this account insert at all? Drives the composer; see lib/practice-journal-gate.ts.
  const canWrite = canWriteJournal(canManage, membership);

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
    // postgrest resolves a failed read as { data: null, error } — rendering that as
    // an empty journal + empty attendance strip is indistinguishable from a fresh
    // room, and leaves nothing to retry. Say it failed instead.
    if (lRes.error || rRes.error || aRes.error) {
      setLoadError(true);
      setLoading(false);
      return;
    }
    // `data: [], error: null` on all three is also what RLS answers an ANON
    // request with, and supabase-js falls back to the anon key for the minute
    // after a failed token refresh — the same minute a venue reconnect or a
    // backgrounded tab waking up lands in. This refetch runs on every
    // refreshSignal bump, so blanking a journal that already had homework, run
    // history or attendance in it (over a fake "nothing here") is a real loss,
    // not a redraw.
    const wentBlank =
      ((lRes.data?.length ?? 0) === 0 && logsRef.current.length > 0) ||
      ((rRes.data?.length ?? 0) === 0 && runsRef.current.length > 0) ||
      ((aRes.data?.length ?? 0) === 0 && attendanceRef.current.length > 0);
    if (wentBlank && !(await hasLiveSession())) {
      setLoading(false);
      return; // keep what's already on screen
    }
    setLoadError(false);
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
      // The membership probe above FAILS OPEN by design, so this branch is still
      // reachable by an outsider: a CEO on venue wifi whose group_roles read blipped
      // resolves to "unknown", gets the composer, and only finds out when 0041
      // refuses the insert. Two things have to happen here, and before this fix
      // neither did:
      //   (a) SAY IT IN THAI. The whole reason lib/practice-journal-gate.ts exists
      //       is that pressing บันทึก put `new row violates row-level security
      //       policy for table "practice_logs"` inside a Thai error toast. Hiding
      //       the composer made that rare; it did not fix the message, and on the
      //       fail-open path the original bug came back verbatim.
      //   (b) BELIEVE THE POLICY — BUT ONLY WHEN IT ANSWERED *US*. The probe is
      //       one-shot — nothing else ever writes to `membership` — so without a
      //       verdict here the composer stays for the whole mount and the same
      //       person can retype the same note and be refused forever, never told
      //       why. A SIGNED refusal is a membership answer, and a better one than
      //       the probe: the policy answered in person.
      //
      //       An UNSIGNED one is not. `anon` holds no privileges on practice_logs
      //       (0026 grants only to `authenticated`), so in the ~minute supabase-js
      //       spends on the anon key after a failed token refresh every insert
      //       here comes back 42501 — and the first cut of this branch read that
      //       as proof, told a real member of the band that only Ar/เมมเบอร์ may
      //       write, and unmounted the composer with their note still in it. The
      //       probe twenty lines above already asks hasLiveSession() before
      //       believing a hostile answer; membershipFromRefusal makes this path
      //       agree with it, and returns null for "learned nothing" so
      //       `membership` — and therefore the composer and the typed text —
      //       stays exactly as it was.
      const signedIn = await hasLiveSession();
      const verdict = membershipFromRefusal(
        isRlsRefusal(error?.code, error?.message),
        signedIn
      );
      if (verdict === "outsider") {
        setMembership(verdict); // collapses into the read-only panel below
        toast.error("บันทึกไม่สำเร็จ", {
          description: "ไม่มีสิทธิ์จดในสมุดซ้อมของวงนี้ — จดได้เฉพาะ Ar และเมมเบอร์ของวงนี้",
        });
        return;
      }
      toast.error("บันทึกไม่สำเร็จ", {
        description: await writeFailureNote(error, signedIn),
      });
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
    // Ask for the row back: RLS lets only the AUTHOR or a band editor tick a log,
    // and a row the policy doesn't match comes back as 0 rows with error null — the
    // optimistic tick would otherwise lie to the very member the homework is for.
    const { data, error } = await supabase
      .from("practice_logs")
      .update({ done: next, updated_at: new Date().toISOString() })
      .eq("id", log.id)
      .select("id");
    if (error) {
      setLogs((prev) => prev.map((l) => (l.id === log.id ? { ...l, done: !next } : l)));
      // NOT error.message: `anon` has no grants on practice_logs, so in the
      // anon-fallback minute this call fails with a table-privilege ERROR (it
      // never reaches the wroteNothing branch below, which is the one that knows
      // how to say "เซสชันหมดอายุ"). Printing the raw text put `permission denied
      // for table practice_logs` in front of a member ticking their own homework.
      toast.error("อัปเดตไม่สำเร็จ", { description: await writeFailureNote(error) });
      return;
    }
    // 0 rows has THREE causes, not one: no permission, the row was deleted, or the
    // request went out UNSIGNED (supabase-js silently falls back to the anon key
    // for ~a minute after a failed token refresh — exactly the window a venue
    // reconnect lands in). Naming only the permission cause tells a member their
    // own homework is not theirs to tick, which is both wrong and discouraging.
    if (wroteNothing(data)) {
      setLogs((prev) => prev.map((l) => (l.id === log.id ? { ...l, done: !next } : l)));
      toast.error("ยังไม่ได้ติ๊ก", { description: await noRowsMessage() });
    }
  }

  async function removeLog(id: string) {
    const ok = await confirm({
      title: "ลบบันทึกนี้?",
      description: "บันทึกการซ้อมรายการนี้จะถูกลบถาวร",
    });
    if (!ok) return;
    const snapshot = logs;
    setLogs((prev) => prev.filter((l) => l.id !== id));
    const supabase = createClient();
    // same reason as toggleDone: a delete the policy doesn't match is 0 rows, not an
    // error — don't leave the entry gone on screen but alive on the server
    const { data, error } = await supabase
      .from("practice_logs")
      .delete()
      .eq("id", id)
      .select("id");
    if (error) {
      setLogs(snapshot); // put it back
      toast.error("ลบไม่สำเร็จ", { description: await writeFailureNote(error) });
      return;
    }
    if (wroteNothing(data)) {
      setLogs(snapshot); // put it back
      toast.error("ลบไม่สำเร็จ", { description: await noRowsMessage() });
    }
  }

  async function setPresent(memberId: string, present: boolean) {
    if (!canManage) return;
    const snapshot = attendance;
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
    const { data, error } = await supabase
      .from("practice_attendance")
      .upsert(
        {
          tenant_id: tenantId,
          group_id: groupId,
          event_id: eventId,
          log_date: today,
          member_id: memberId,
          present,
        },
        { onConflict: "event_id,log_date,member_id" }
      )
      .select("id");
    // never leave a tick on screen that never reached the server — an Ar would
    // believe they took attendance
    if (error) {
      setAttendance(snapshot);
      toast.error("เช็คชื่อไม่สำเร็จ", { description: await writeFailureNote(error) });
      return;
    }
    // an upsert that lands on the UPDATE branch (member already marked today) can
    // touch 0 rows the same way any other guarded write here can
    if (wroteNothing(data)) {
      setAttendance(snapshot);
      toast.error("เช็คชื่อไม่สำเร็จ", { description: await noRowsMessage() });
    }
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

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
        <p>โหลดสมุดซ้อมไม่สำเร็จ — อาจออฟไลน์อยู่หรือเน็ตมีปัญหา</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoading(true);
            load();
          }}
        >
          ลองใหม่
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* compose — only for accounts migration 0041 will actually let write.
          When it is hidden, SAY SO: a box that silently disappears reads as a
          broken page, and the person it disappears for (a label-wide CEO) is
          exactly the person least able to guess why. */}
      {canWrite ? (
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
      ) : (
        <div className="rounded-xl border border-dashed bg-muted/30 p-4">
          {/* Scoped to AUTHORING on purpose. This said "ดูได้อย่างเดียว" until a
              reviewer pointed out it is not true on this screen: a CEO who wrote
              journal entries BEFORE 0041 closed that door still owns those rows,
              and 0024's delete clause (author_id = auth.uid()) still lets them
              delete each one — so the history below renders them a working ลบ
              button and a working homework tick. Telling someone they have no
              write access while handing them the only irreversible control on a
              page with no undo is the worst direction for this copy to be wrong
              in. canModifyLog is right; it was the headline that was wrong. */}
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <Eye className="h-4 w-4" /> จดบันทึกใหม่ไม่ได้
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            สมุดซ้อมเป็นของคนในวง — Ar หรือเมมเบอร์ของวงนี้เท่านั้นที่จดได้
            บัญชีระดับ Label (เช่น CEO) เปิดดูได้ทุกวง แต่เขียนใหม่ไม่ได้
            {/* only say this to someone who actually has old rows down there */}
            {logs.some((l) => l.author_id === currentUserId) &&
              " (บันทึกเก่าที่ตัวเองเคยเขียนไว้ ยังลบและติ๊กได้)"}
          </p>
        </div>
      )}

      {/* outstanding homework (carry over) */}
      {outstandingHomework.length > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="mb-2 text-sm font-semibold">📌 การบ้านค้าง</p>
          {/* RLS lets only the AUTHOR or a band editor tick a log (mig 0024), and that
              is deliberate — the Ar ticks the band's homework off. So a member who can
              tick nothing here gets the list plus one line saying who does it, rather
              than a row of checkboxes that always bounce back. */}
          {!canManage && !outstandingHomework.some((l) => l.author_id === currentUserId) && (
            <p className="mb-2 text-xs text-muted-foreground">
              {/* the "บอก Ar ให้ติ๊กให้" line is advice for a BAND MEMBER waiting on
                  their Ar. Said to a label-wide observer who has no homework here
                  at all, it is nonsense — give them the rule instead. */}
              {canWrite
                ? "ทำเสร็จแล้วบอก Ar ให้ติ๊กให้นะ — ติ๊กเองไม่ได้"
                : "ติ๊กได้เฉพาะเจ้าของบันทึก หรือ Ar ของวงนี้"}
            </p>
          )}
          <div className="space-y-1.5">
            {outstandingHomework.map((l) => (
              <label key={l.id} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={l.done}
                  disabled={!canModifyLog(canManage, l.author_id === currentUserId)}
                  onChange={() => toggleDone(l)}
                  className="mt-0.5 h-4 w-4 accent-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50"
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
          {/* "เริ่มจดด้านบนได้เลย" points at a composer that is not there for a
              read-only viewer — don't send them looking for it. */}
          {canWrite ? "ยังไม่มีบันทึกการซ้อม — เริ่มจดด้านบนได้เลย" : "ยังไม่มีบันทึกการซ้อม"}
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
                  // WHO may write is the same for both controls — author or band
                  // editor (0024's practice_logs_delete, and the USING half of
                  // practice_logs_update as 0038 §P5 recreated it) — so one
                  // predicate drives both the ลบ button and the homework tick.
                  // §P5 added a WITH CHECK to UPDATE only; see canModifyLog's
                  // docblock for why the tick still satisfies it.
                  const canEditThis = canModifyLog(canManage, l.author_id === currentUserId);
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
                          {/* The carry-over list at the top of this page has had this
                              gate since 951b4fe ("don't offer a homework tick that RLS
                              will always bounce"); the SAME homework rendered again
                              down here in the dated history never got it. RLS
                              (practice_logs_update — 0024, rewritten by 0038 §P5) lets
                              only the author or a band editor tick, so anyone else
                              ticking here watched the box flip and flip back with an
                              error toast. canEditThis is the same predicate the ลบ
                              button above already uses. §P5's extra WITH CHECK doesn't
                              bite: toggleDone writes only done + updated_at, so
                              group_id and visibility never move. */}
                          <input
                            type="checkbox"
                            checked={l.done}
                            disabled={!canEditThis}
                            onChange={() => toggleDone(l)}
                            className="h-3.5 w-3.5 accent-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50"
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
