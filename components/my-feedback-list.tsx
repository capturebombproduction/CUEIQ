"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bug, Check, CornerDownRight, Lightbulb, Loader2, MessageCircle, RotateCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";
import { Button } from "@/components/ui/button";
import { FeedbackThumbs } from "@/components/feedback-thumbs";
import { cn } from "@/lib/utils";

/**
 * "ที่ส่งไปแล้ว" — a person's own reports, and what the team said back.
 *
 * Its own component because it is shown in two places for two different reasons:
 * inside the แจ้งปัญหา dialog (where someone already is when they wonder), and at
 * /feedback (which is where the notification about a reply has to land — a bell
 * item that opens nothing is the same broken promise as no reply at all).
 *
 * Needs no new RLS: feedback_select has always read
 * `user_id = auth.uid() or can_admin_tenant(tenant_id)`.
 */
export interface MyFeedbackRow {
  id: string;
  category: string;
  message: string;
  status: string;
  created_at: string;
  reply: string | null;
  replied_at: string | null;
  reply_seen_at: string | null;
  images: string[] | null;
}

// Category as a chip: icon + word (the Dev Inbox reads the same).
const CAT_CHIP: Record<string, { Icon: typeof Bug; label: string; cls: string; en: boolean }> = {
  bug: { Icon: Bug, label: "Bug", cls: "chip-warning", en: true },
  idea: { Icon: Lightbulb, label: "Idea", cls: "chip-info", en: true },
  other: { Icon: MessageCircle, label: "อื่น ๆ", cls: "chip-neutral", en: false },
};

export function whenTH(iso: string) {
  return new Date(iso).toLocaleString("th-TH", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Rows with an answer the author has not opened yet. */
export function unreadReplies(rows: MyFeedbackRow[]): MyFeedbackRow[] {
  return rows.filter((r) => r.reply && !r.reply_seen_at);
}

/**
 * "A new report just landed" — fired on window by the Feedback tile after a successful
 * send, so EVERY mounted list re-reads: /feedback renders its own list under the tile,
 * separate from the one inside the tile's dialog, and the person who just reported a
 * bug is looking straight at it. A window event rather than a prop because the tile
 * lives in the shell (account panel, Live tools) and the page list in a server page.
 */
export const FEEDBACK_SENT_EVENT = "cueiq:feedback-sent";
export function announceFeedbackSent() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(FEEDBACK_SENT_EVENT));
}

export function MyFeedbackList({
  userId,
  onSeen,
}: {
  userId: string;
  /** Called with how many unread answers were just stamped as read, so a badge
   *  outside this component can come down at the same moment. */
  onSeen?: (count: number) => void;
}) {
  const [rows, setRows] = useState<MyFeedbackRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Reads can now overlap (a re-read on FEEDBACK_SENT_EVENT, a retry): only the
  // newest may land, so an older answer cannot overwrite the list it was raced by.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoadFailed(false);
    const { data, error } = await createClient()
      .from("feedback")
      .select(
        "id, category, message, status, created_at, reply, replied_at, reply_seen_at, images"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(30);
    if (seq !== loadSeq.current) return;
    // AN EMPTY READ IS NOT AN EMPTY TABLE (lib/auth-session.ts). supabase-js
    // substitutes the anon key after a failed token refresh and RLS then answers []
    // with error: null — and this is the page a "ทีมงานตอบฟีดแบคของคุณแล้ว"
    // notification lands on, so rendering "ยังไม่เคยส่งฟีดแบค" there would tell
    // someone their report never existed at the very moment it was answered.
    if (error) {
      setLoadFailed(true);
      return;
    }
    if (data && data.length === 0 && !(await hasLiveSession())) {
      if (seq === loadSeq.current) setLoadFailed(true);
      return;
    }
    if (data && seq === loadSeq.current) setRows(data as MyFeedbackRow[]);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A report sent from the Feedback tile (see FEEDBACK_SENT_EVENT) — re-read in place;
  // the rows already shown stay up until the new answer replaces them.
  useEffect(() => {
    const reload = () => void load();
    window.addEventListener(FEEDBACK_SENT_EVENT, reload);
    return () => window.removeEventListener(FEEDBACK_SENT_EVENT, reload);
  }, [load]);

  // Opening this list IS reading it. The stamp goes on the ROW rather than into
  // localStorage so the dot clears on the phone as well as on the laptop. Best
  // effort: a failed write just leaves the dot up, which is the harmless direction.
  useEffect(() => {
    if (!rows) return;
    const ids = unreadReplies(rows).map((r) => r.id);
    if (!ids.length) return;
    const now = new Date().toISOString();
    let alive = true;
    void createClient()
      .from("feedback")
      .update({ reply_seen_at: now })
      .in("id", ids)
      .select("id")
      .then(({ data }) => {
        if (!alive || !data?.length) return;
        setRows((prev) =>
          prev
            ? prev.map((r) => (ids.includes(r.id) ? { ...r, reply_seen_at: now } : r))
            : prev
        );
        onSeen?.(data.length);
      });
    return () => {
      alive = false;
    };
    // onSeen is a callback prop; re-running on its identity would re-stamp forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  if (loadFailed) {
    return (
      <div className="space-y-3 rounded-[2px] border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
        <p>โหลดรายการไม่สำเร็จ</p>
        <Button variant="secondary" onClick={() => void load()}>
          <RotateCw aria-hidden /> ลองอีกครั้ง
        </Button>
      </div>
    );
  }

  if (rows === null) {
    return (
      <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> กำลังโหลด…
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-[2px] border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
        ยังไม่เคยส่งฟีดแบค
      </p>
    );
  }

  return (
    <div className="stack">
      {rows.map((r) => {
        const cat = CAT_CHIP[r.category] ?? CAT_CHIP.other;
        return (
          // A thread: what they wrote on the left, the team's answer on the right.
          <article key={r.id} className="slab space-y-2.5 p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
              <span className={cn("chip", cat.cls, cat.en && "en")}>
                <cat.Icon aria-hidden />
                {cat.label}
              </span>
              <span>{whenTH(r.created_at)}</span>
              {r.status === "done" && (
                <span className="chip chip-success">
                  <Check aria-hidden /> จัดการแล้ว
                </span>
              )}
            </div>
            <p className="max-w-[92%] whitespace-pre-wrap break-words rounded-[2px] bg-muted px-3 py-2 text-[15px] leading-relaxed sm:max-w-[80%]">
              {r.message}
            </p>
            {!!r.images?.length && <FeedbackThumbs keys={r.images} />}
            {r.reply ? (
              <div
                data-testid="feedback-reply"
                className="ml-auto max-w-[92%] rounded-[2px] bg-primary/[.12] px-3 py-2 shadow-[inset_0_0_0_1px_hsl(var(--primary)/.3)] sm:max-w-[80%]"
              >
                <p className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-primary-ink">
                  <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
                  ทีมงานตอบกลับ
                  {r.replied_at && (
                    <span className="font-normal text-muted-foreground">
                      · {whenTH(r.replied_at)}
                    </span>
                  )}
                </p>
                <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{r.reply}</p>
              </div>
            ) : (
              <p className="text-right text-[12.5px] text-muted-foreground">ยังไม่มีคำตอบ</p>
            )}
          </article>
        );
      })}
    </div>
  );
}
