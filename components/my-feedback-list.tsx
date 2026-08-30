"use client";

import { useCallback, useEffect, useState } from "react";
import { Bug, Check, CornerDownRight, Lightbulb, Loader2, MessageCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FeedbackImage } from "@/components/feedback-image";

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

const CAT_ICON: Record<string, typeof Bug> = {
  bug: Bug,
  idea: Lightbulb,
  other: MessageCircle,
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

  const load = useCallback(async () => {
    setLoadFailed(false);
    const { data, error } = await createClient()
      .from("feedback")
      .select(
        "id, category, message, status, created_at, reply, replied_at, reply_seen_at, images"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(30);
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
      setLoadFailed(true);
      return;
    }
    if (data) setRows(data as MyFeedbackRow[]);
  }, [userId]);

  useEffect(() => {
    void load();
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
      <div className="space-y-2 rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
        <p>โหลดรายการไม่สำเร็จ</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          ลองอีกครั้ง
        </Button>
      </div>
    );
  }

  if (rows === null) {
    return (
      <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> กำลังโหลด…
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
        ยังไม่เคยส่งฟีดแบค
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const Icon = CAT_ICON[r.category] ?? MessageCircle;
        return (
          <div key={r.id} className="space-y-2 rounded-lg border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Icon className="h-3.5 w-3.5" />
              <span>{whenTH(r.created_at)}</span>
              {r.status === "done" && (
                <Badge variant="secondary" className="gap-1">
                  <Check className="h-3 w-3" /> จัดการแล้ว
                </Badge>
              )}
            </div>
            <p className="whitespace-pre-wrap text-sm">{r.message}</p>
            {!!r.images?.length && (
              <div className="flex flex-wrap gap-2">
                {r.images.map((k) => (
                  <FeedbackImage key={k} objectKey={k} />
                ))}
              </div>
            )}
            {r.reply ? (
              <div
                data-testid="feedback-reply"
                className="rounded-md border-l-2 border-primary bg-muted/50 p-2"
              >
                <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-primary">
                  <CornerDownRight className="h-3.5 w-3.5" />
                  ทีมงานตอบกลับ
                  {r.replied_at && (
                    <span className="font-normal text-muted-foreground">
                      · {whenTH(r.replied_at)}
                    </span>
                  )}
                </p>
                <p className="whitespace-pre-wrap text-sm">{r.reply}</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">ยังไม่มีคำตอบ</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
