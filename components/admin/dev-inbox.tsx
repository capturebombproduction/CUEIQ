"use client";

import { useEffect, useState } from "react";
import {
  Bug,
  Lightbulb,
  MessageCircle,
  Check,
  Trash2,
  Loader2,
  RefreshCw,
  AlertTriangle,
  X,
  CornerDownRight,
  Send,
  User,
  CircleCheck,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { noRowsMessage, wroteNothing } from "@/lib/write-guard";
import { notify } from "@/lib/notify-client";
import { removeEventAudio } from "@/lib/audio-remote";
import { FeedbackThumbs } from "@/components/feedback-thumbs";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

interface FeedbackRow {
  id: string;
  user_id: string | null;
  category: string;
  message: string;
  status: string;
  context: { path?: string | null; commit?: string | null; ua?: string | null } | null;
  created_at: string;
  reply: string | null;
  replied_at: string | null;
  images: string[] | null;
}
interface ErrorRow {
  id: string;
  kind: string;
  message: string;
  stack: string | null;
  url: string | null;
  app_version: string | null;
  created_at: string;
}

// Errors that are noise even if they slipped past the reporter filter (old rows
// pre-dating the isDevOrigin + hydration guard in client-log.ts).
const NOISE_PATTERNS = [
  /Minified React error #(418|419|420|421|422|423|425)\b/i,
  /hydrat/i,
  /Text content does not match server-rendered HTML/i,
  /webpack-internal:/i,
];
function isNoise(r: ErrorRow): boolean {
  if (r.url?.startsWith("webpack-internal:")) return true;
  if (r.url?.includes("localhost") || r.url?.includes("127.0.0.1")) return true;
  return NOISE_PATTERNS.some((re) => re.test(r.message) || re.test(r.url ?? ""));
}

// Group consecutive identical messages so the inbox doesn't flood with the same
// error repeated across sessions/deploys.
interface ErrorGroup {
  key: string;
  count: number;
  first: ErrorRow;
  last_seen: string;
  ids: string[];
}
function groupErrors(rows: ErrorRow[]): ErrorGroup[] {
  const map = new Map<string, ErrorGroup>();
  for (const r of rows) {
    const key = `${r.kind}:${r.message.slice(0, 80)}`;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
      existing.ids.push(r.id);
      if (r.created_at > existing.last_seen) existing.last_seen = r.created_at;
    } else {
      map.set(key, { key, count: 1, first: r, last_seen: r.created_at, ids: [r.id] });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}

// Category as a chip: icon + word, tone by kind (spec §G.8).
const CAT_CHIP: Record<string, { Icon: typeof Bug; label: string; cls: string; en: boolean }> = {
  bug: { Icon: Bug, label: "Bug", cls: "chip-warning", en: true },
  idea: { Icon: Lightbulb, label: "Idea", cls: "chip-info", en: true },
  other: { Icon: MessageCircle, label: "อื่น ๆ", cls: "chip-neutral", en: false },
};

function when(iso: string) {
  return new Date(iso).toLocaleString("th-TH", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.pathname + (u.hash || "");
  } catch {
    return url.slice(0, 60);
  }
}

export function DevInbox({
  namesById = {},
  adminUserId,
}: {
  namesById?: Record<string, string>;
  /** The signed-in admin, stamped onto each reply as replied_by. */
  adminUserId?: string;
}) {
  const confirm = useConfirm();
  const [fb, setFb] = useState<FeedbackRow[]>([]);
  // The reply being typed, per feedback id. Kept out of the row objects so a
  // reload() mid-typing cannot wipe what an admin has half-written.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [errs, setErrs] = useState<ErrorRow[]>([]);
  const [showNoise, setShowNoise] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const supabase = createClient();
    const [f, e] = await Promise.all([
      supabase.from("feedback").select("*").order("created_at", { ascending: false }).limit(100),
      supabase.from("client_errors").select("*").order("created_at", { ascending: false }).limit(200),
    ]);
    setFb((f.data ?? []) as FeedbackRow[]);
    setErrs((e.data ?? []) as ErrorRow[]);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function toggleDone(id: string, status: string) {
    const next = status === "done" ? "open" : "done";
    setFb((p) => p.map((r) => (r.id === id ? { ...r, status: next } : r)));
    const { data, error } = await createClient()
      .from("feedback")
      .update({ status: next })
      .eq("id", id)
      .select("id");
    // A write that reported no error but touched no row did not happen
    // (lib/write-guard.ts) — and this is the button whose entire job is to say
    // "this one is handled", so it must not say it falsely.
    if (error || wroteNothing(data)) {
      setFb((p) => p.map((r) => (r.id === id ? { ...r, status } : r)));
      toast.error("เปลี่ยนสถานะไม่สำเร็จ", {
        description: error?.message ?? (await noRowsMessage()),
      });
    }
  }

  /**
   * Answer one report. The reply lands on the row (0043) and the author is told —
   * both halves matter: five people wrote in over two months and none of them ever
   * heard anything, which is how a channel like this stops being used.
   *
   * The notify() call is fire-and-forget by design and swallows its own errors, so
   * it is NOT what decides success here — the row write is.
   */
  async function sendReply(id: string) {
    const text = (drafts[id] ?? "").trim();
    if (text.length < 2) {
      toast.error("พิมพ์คำตอบสักนิดครับ");
      return;
    }
    setSending(id);
    try {
      const now = new Date().toISOString();
      const { data, error } = await createClient()
        .from("feedback")
        .update({
          reply: text.slice(0, 4000),
          replied_at: now,
          // 0043 declares replied_by and the guard trigger protects it; without
          // this nothing ever wrote it, so in a label with several admins every
          // answer recorded WHEN but never WHO.
          replied_by: adminUserId ?? null,
          reply_seen_at: null,
        })
        .eq("id", id)
        .select("id");
      if (error) throw new Error(error.message);
      if (wroteNothing(data)) throw new Error(await noRowsMessage());
      setFb((p) =>
        p.map((r) => (r.id === id ? { ...r, reply: text, replied_at: now } : r))
      );
      setDrafts((d) => ({ ...d, [id]: "" }));
      notify("feedback_replied", { feedbackId: id });
      toast.success("ส่งคำตอบแล้ว");
    } catch (e) {
      toast.error("ส่งคำตอบไม่สำเร็จ", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSending(null);
    }
  }
  async function delFb(id: string) {
    if (!(await confirm({ title: "ลบฟีดแบคนี้?", description: "ลบถาวร กู้คืนไม่ได้" }))) return;
    // Capture the attachment keys BEFORE the row goes: they exist nowhere else, so
    // once it is deleted nothing can ever name those objects again and they sit in
    // the bucket being counted by the Admin storage gauge for ever. Every other
    // delete in this app reclaims its R2 objects (group-manager, song-library,
    // setlist-builder); this path predates images and was missed when 0043 added
    // them. Best-effort — a failed cleanup must not stop the delete the admin asked
    // for, and "ลบถาวร" has to be true of the picture too.
    const keys = fb.find((r) => r.id === id)?.images ?? [];
    setFb((p) => p.filter((r) => r.id !== id));
    await createClient().from("feedback").delete().eq("id", id);
    await Promise.allSettled(keys.map((k) => removeEventAudio(k)));
  }
  async function delGroup(ids: string[]) {
    if (!ids.length) return;
    setErrs((p) => p.filter((r) => !ids.includes(r.id)));
    await createClient().from("client_errors").delete().in("id", ids);
  }
  async function clearNoise() {
    if (!(await confirm({ title: "ล้าง noise ทั้งหมด?", description: "ลบ error ที่เป็น hydration / localhost ออก — ลบถาวร" }))) return;
    const noiseIds = errs.filter(isNoise).map((r) => r.id);
    if (!noiseIds.length) return;
    setErrs((p) => p.filter((r) => !noiseIds.includes(r.id)));
    await createClient().from("client_errors").delete().in("id", noiseIds);
  }
  async function clearAll() {
    if (!(await confirm({ title: "ล้าง error ทั้งหมด?", description: "ลบทุก row ในตาราง client_errors — ลบถาวร" }))) return;
    setErrs([]);
    // delete via RLS (admin only), bulk by tenant
    const supabase = createClient();
    const { data: tenant } = await supabase.from("tenants").select("id").single();
    if (tenant) await supabase.from("client_errors").delete().eq("tenant_id", tenant.id);
  }

  const openCount = fb.filter((r) => r.status !== "done").length;
  const realErrs = errs.filter((r) => !isNoise(r));
  const noiseErrs = errs.filter(isNoise);
  const visibleErrs = showNoise ? errs : realErrs;
  const groups = groupErrors(visibleErrs);

  return (
    <Tabs defaultValue="feedback" className="w-full">
      <div className="flex items-center justify-between gap-2">
        <TabsList className="flex-1 sm:max-w-md [&>*]:h-11 sm:[&>*]:h-[38px]">
          <TabsTrigger value="feedback">
            ฟีดแบค
            {openCount > 0 && <span className="num text-[15px]">{openCount}</span>}
          </TabsTrigger>
          <TabsTrigger value="errors">
            ปัญหา (Errors)
            {realErrs.length > 0 && <span className="num text-[15px]">{realErrs.length}</span>}
          </TabsTrigger>
        </TabsList>
        <Button variant="secondary" size="icon" title="โหลดใหม่" aria-label="โหลดใหม่" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
        </Button>
      </div>

      {/* feedback — one thread per report: their message, then the answer */}
      <TabsContent value="feedback" className="mt-3">
        {!loading && fb.length === 0 && (
          <p className="rounded-[2px] border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
            ยังไม่มีฟีดแบค
          </p>
        )}
        <div className="stack">
          {fb.map((r) => {
            const cat = CAT_CHIP[r.category] ?? CAT_CHIP.other;
            const done = r.status === "done";
            const who = r.user_id ? namesById[r.user_id] : null;
            return (
              <article key={r.id} className="slab space-y-2.5 p-3 sm:p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
                    {!done && (
                      <span
                        aria-hidden
                        title="ยังไม่ได้จัดการ"
                        className="dot static inline-block shrink-0"
                      />
                    )}
                    <span className={cn("chip", cat.cls, cat.en && "en")}>
                      <cat.Icon aria-hidden />
                      {cat.label}
                    </span>
                    {/* Who wrote it. The inbox never showed this, so answering a
                        report meant guessing who to talk to — and the reply below
                        is worth much less if you cannot tell whose bug it was. */}
                    {who && (
                      <span className="inline-flex items-center gap-1 font-semibold text-foreground">
                        <User className="h-3.5 w-3.5" aria-hidden /> {who}
                      </span>
                    )}
                    <span>{when(r.created_at)}</span>
                    {done && (
                      <span className="chip chip-success">
                        <Check aria-hidden /> จัดการแล้ว
                      </span>
                    )}
                  </div>
                  <div className="-mr-1.5 -mt-1.5 flex shrink-0">
                    <Button
                      variant="ghost" size="icon"
                      title={done ? "ทำเป็นยังไม่เสร็จ" : "ทำเครื่องหมายว่าจัดการแล้ว"}
                      onClick={() => toggleDone(r.id, r.status)}
                      className={done ? "text-success-ink" : ""}
                    >
                      <Check aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon" title="ลบ" aria-label="ลบ" onClick={() => delFb(r.id)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </div>

                {/* Their message: a bubble on the left, with where it came from. */}
                <div className={cn("max-w-[92%] rounded-[2px] bg-muted px-3 py-2 sm:max-w-[80%]", done && "opacity-60")}>
                  <p className={cn("whitespace-pre-wrap break-words text-[15px] leading-relaxed", done && "line-through")}>
                    {r.message}
                  </p>
                  {(r.context?.path || r.context?.commit || r.context?.ua) && (
                    <p className="mt-1 flex min-w-0 flex-wrap gap-x-2 text-[12px] text-muted-foreground">
                      {r.context?.commit && <span className="num text-[13px]">{r.context.commit}</span>}
                      {r.context?.path && <span className="min-w-0 truncate font-mono">{r.context.path}</span>}
                      {r.context?.ua && (
                        <span className="min-w-0 max-w-full truncate" title={r.context.ua}>
                          {r.context.ua}
                        </span>
                      )}
                    </p>
                  )}
                </div>

                {!!r.images?.length && <FeedbackThumbs keys={r.images} />}

                {/* The answer: on the right, in the band's colour. */}
                {r.reply && (
                  <div className="ml-auto max-w-[92%] rounded-[2px] bg-primary/[.12] px-3 py-2 shadow-[inset_0_0_0_1px_hsl(var(--primary)/.3)] sm:max-w-[80%]">
                    <p className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-primary-ink">
                      <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
                      ตอบไปแล้ว
                      {r.replied_at && (
                        <span className="font-normal text-muted-foreground">
                          · {when(r.replied_at)}
                        </span>
                      )}
                    </p>
                    <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{r.reply}</p>
                  </div>
                )}

                <div className="flex items-end gap-2">
                  <Textarea
                    value={drafts[r.id] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                    rows={2}
                    placeholder={r.reply ? "แก้คำตอบ / ตอบเพิ่ม…" : "ตอบกลับคนที่แจ้งมา…"}
                    aria-label="คำตอบ"
                    data-testid={`feedback-reply-input-${r.id}`}
                    className="min-h-[64px] min-w-0 flex-1"
                  />
                  <Button
                    onClick={() => sendReply(r.id)}
                    disabled={sending === r.id || !(drafts[r.id] ?? "").trim()}
                  >
                    {sending === r.id ? (
                      <Loader2 className="animate-spin" aria-hidden />
                    ) : (
                      <Send aria-hidden />
                    )}
                    ตอบ
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      </TabsContent>

      {/* errors */}
      <TabsContent value="errors" className="mt-3 space-y-3">
        {/* toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span>
              <span className="num text-[15px] text-foreground">{realErrs.length}</span> error จริง
            </span>
            {noiseErrs.length > 0 && (
              <button
                type="button"
                className="min-h-11 underline-offset-2 hover:underline sm:min-h-0"
                onClick={() => setShowNoise((v) => !v)}
              >
                {showNoise ? `ซ่อน noise (${noiseErrs.length})` : `+ noise ${noiseErrs.length}`}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            {noiseErrs.length > 0 && (
              <Button variant="secondary" size="sm" onClick={clearNoise} className="h-11 sm:h-9">
                <X aria-hidden /> ล้าง noise
              </Button>
            )}
            {errs.length > 0 && (
              <Button variant="destructive-outline" size="sm" onClick={clearAll} className="h-11 sm:h-9">
                <Trash2 aria-hidden /> ล้างทั้งหมด
              </Button>
            )}
          </div>
        </div>

        {!loading && groups.length === 0 && (
          <p className="flex items-center justify-center gap-2 rounded-[2px] border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
            <CircleCheck className="h-4 w-4 text-success-ink" aria-hidden />
            ไม่มี error ที่ถูกบันทึก — ดีงาม
          </p>
        )}
        <div className="stack">
          {groups.map((g) => {
            const r = g.first;
            const noise = isNoise(r);
            return (
              <article key={g.key} className={cn("slab p-3 sm:p-4", noise && "opacity-60")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
                      <AlertTriangle
                        className={cn("h-4 w-4", noise ? "text-muted-foreground" : "text-destructive")}
                        aria-hidden
                      />
                      <span>{when(g.last_seen)}</span>
                      <Badge variant="outline">{r.kind}</Badge>
                      {g.count > 1 && (
                        <Badge variant="secondary">
                          <span className="num text-[13px]">×{g.count}</span>
                        </Badge>
                      )}
                      {r.app_version && <span className="num text-[13px]">{r.app_version}</span>}
                      {noise && <Badge variant="outline" className="en">noise</Badge>}
                    </div>
                    <p className="break-words text-[14px] font-semibold">{r.message}</p>
                    {r.url && (
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {shortUrl(r.url)}
                      </p>
                    )}
                    {r.stack && (
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-[2px] bg-muted p-2 text-[11px] text-muted-foreground">
                        {r.stack}
                      </pre>
                    )}
                  </div>
                  <Button
                    variant="ghost" size="icon" title="ลบกลุ่มนี้" aria-label="ลบกลุ่มนี้"
                    onClick={() => delGroup(g.ids)}
                    className="-mr-1.5 -mt-1.5 shrink-0"
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      </TabsContent>
    </Tabs>
  );
}
