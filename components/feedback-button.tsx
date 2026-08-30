"use client";

import { useEffect, useRef, useState } from "react";
import {
  MessageSquarePlus,
  Loader2,
  Bug,
  Lightbulb,
  MessageCircle,
  ImagePlus,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { APP_VERSION } from "@/lib/app-version";
import { isQueueableWriteError } from "@/lib/mgmt-outbox";
import {
  FEEDBACK_IMAGE_EXTS,
  buildFeedbackImagePath,
  uploadEventAudio,
} from "@/lib/audio-remote";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { MyFeedbackList } from "@/components/my-feedback-list";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Category = "bug" | "idea" | "other";

const CATS: { value: Category; label: string; icon: typeof Bug }[] = [
  { value: "bug", label: "พบปัญหา/บั๊ก", icon: Bug },
  { value: "idea", label: "ไอเดีย/อยากได้เพิ่ม", icon: Lightbulb },
  { value: "other", label: "อื่น ๆ", icon: MessageCircle },
];

/** A phone screenshot is ~200 KB–2 MB; three of them is plenty to show a bug, and
 *  the cap keeps a stray 40 MB photo out of a bucket whose free tier the whole
 *  label's audio also lives in. */
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Past this a screenshot upload is not coming back — do not hold the report (or
 *  the modal, which covers the whole app) hostage to it. */
const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * In-app feedback / bug-report channel — open to EVERY logged-in user (the point
 * is to gather real-use feedback from band members during live shows). Stores into
 * public.feedback with the page + build auto-attached so the team can fix the
 * right spot. Self-contained (Supabase + R2, no external service).
 *
 * ⚠️ ONE FILE, TWO APPS. The desktop shell mounts this exact module through vite's
 * "@" → repo-root alias, so everything here must work under file:// in Electron:
 * no Next imports, and the Supabase client stays imported as `@/lib/supabase/client`
 * (aliased to the desktop's localStorage-backed client — a relative import would
 * silently make every query run as ANON).
 *
 * SINCE 2026-08-31 IT IS A TWO-WAY CHANNEL. Five reports sat in the table for two
 * months, three of them fixed, and not one person who wrote in was ever told —
 * which is how a feedback channel dies. "ที่ส่งไปแล้ว" shows the author their own
 * reports and the admin's answer, and the button carries a dot when an answer is
 * waiting. Attachments were asked for by name on 2026-08-13.
 */
export function FeedbackButton({
  userId,
  tenantId,
  floating = false,
}: {
  userId?: string | null;
  tenantId?: string | null;
  /** Render as a prominent floating button (bottom-right) instead of a header
   *  icon — so band members actually notice it and report in-app (with the page
   *  + build auto-attached) rather than messaging the team with no context. */
  floating?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"new" | "mine">("new");
  const [category, setCategory] = useState<Category>("bug");
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [unread, setUnread] = useState(0);
  // Remount the list on each submit so a brand-new report shows without reopening.
  const [listRev, setListRev] = useState(0);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // Object URLs for the not-yet-uploaded previews, revoked on replace/unmount.
  const previews = useRef(new Map<File, string>());

  const previewUrl = (f: File) => {
    let u = previews.current.get(f);
    if (!u) {
      u = URL.createObjectURL(f);
      previews.current.set(f, u);
    }
    return u;
  };
  useEffect(() => {
    const held = previews.current;
    return () => {
      held.forEach((u) => URL.revokeObjectURL(u));
      held.clear();
    };
  }, []);

  // The unread-answer dot. Cheap, once per mount: this is the only thing that
  // tells someone their two-month-old bug report was finally answered.
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    createClient()
      .from("feedback")
      .select("id")
      .eq("user_id", userId)
      .not("reply", "is", null)
      .is("reply_seen_at", null)
      .then(({ data }) => {
        if (alive && data) setUnread(data.length);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  function addFiles(picked: FileList | null) {
    if (!picked?.length) return;
    const room = MAX_IMAGES - files.length;
    if (room <= 0) {
      toast.error(`แนบได้สูงสุด ${MAX_IMAGES} รูป`);
      return;
    }
    const accepted: File[] = [];
    for (const f of Array.from(picked).slice(0, room)) {
      const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase() ?? "";
      if (!f.type.startsWith("image/") && !(FEEDBACK_IMAGE_EXTS as readonly string[]).includes(ext)) {
        toast.error("แนบได้เฉพาะรูปภาพ", { description: f.name });
        continue;
      }
      if (f.size > MAX_IMAGE_BYTES) {
        toast.error("รูปใหญ่เกินไป (เกิน 8 MB)", { description: f.name });
        continue;
      }
      accepted.push(f);
    }
    if (accepted.length) setFiles((prev) => [...prev, ...accepted]);
  }

  function removeFile(f: File) {
    const u = previews.current.get(f);
    if (u) {
      URL.revokeObjectURL(u);
      previews.current.delete(f);
    }
    setFiles((prev) => prev.filter((x) => x !== f));
  }

  if (!userId || !tenantId) return null;

  async function submit() {
    const msg = message.trim();
    if (msg.length < 3) {
      toast.error("พิมพ์รายละเอียดสักนิดนะครับ");
      return;
    }
    setBusy(true);
    try {
      // Bytes FIRST, row second: the row then lists only what actually landed, so
      // "ที่ส่งไปแล้ว" never shows a placeholder for a picture that was never
      // uploaded. An upload that fails must not cost the person their report —
      // the words are the valuable part — so it is reported and the text still goes.
      const keys: string[] = [];
      let uploadFailures = 0;
      for (const f of files) {
        const key = buildFeedbackImagePath(tenantId!, userId!, f.name);
        try {
          // BOUNDED. uploadEventAudio is built for 88 MB masters and its PUT takes
          // no signal and no timeout; on a black-holed venue AP a screenshot upload
          // would never settle, and this dialog would sit in front of the whole app
          // — including a running show — with every way out disabled. A screenshot
          // is a few hundred KB: past a minute it is not coming back.
          await Promise.race([
            uploadEventAudio(key, f, f.type),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("upload timeout")), UPLOAD_TIMEOUT_MS)
            ),
          ]);
          keys.push(key);
        } catch {
          uploadFailures += 1;
        }
      }

      const supabase = createClient();
      const { error } = await supabase.from("feedback").insert({
        tenant_id: tenantId,
        user_id: userId,
        category,
        message: msg.slice(0, 4000),
        images: keys,
        context: {
          path:
            typeof location !== "undefined"
              ? location.pathname + location.hash
              : null,
          commit: APP_VERSION,
          ua:
            typeof navigator !== "undefined"
              ? navigator.userAgent.slice(0, 300)
              : null,
        },
      });
      if (error) throw new Error(error.message);
      if (uploadFailures > 0) {
        toast.warning(`ส่งข้อความแล้ว แต่แนบรูปไม่สำเร็จ ${uploadFailures} รูป`, {
          description: "ลองส่งรูปอีกครั้งเมื่อสัญญาณดีขึ้นได้ครับ",
        });
      } else {
        toast.success("ส่งฟีดแบคแล้ว — ขอบคุณมากครับ 🙏");
      }
      setMessage("");
      setCategory("bug");
      files.forEach((f) => {
        const u = previews.current.get(f);
        if (u) URL.revokeObjectURL(u);
        previews.current.delete(f);
      });
      setFiles([]);
      setOpen(false);
      setListRev((n) => n + 1);
    } catch (e) {
      // A venue with no signal is this button's NORMAL habitat (see the doc
      // comment above) — a bare "TypeError: Failed to fetch" toast title reads
      // as gibberish to a band member and the report is then just lost. Detect
      // the network case the same way the outbox call sites do and give it a
      // Thai headline; the typed text stays in the box either way (only the
      // success path above clears it), so nothing is lost to retype later.
      const msg = e instanceof Error ? e.message : null;
      const onLine = typeof navigator === "undefined" || navigator.onLine !== false;
      if (isQueueableWriteError(msg, onLine)) {
        toast.error("ออฟไลน์อยู่ — ส่งไม่สำเร็จ", {
          description: "ข้อความยังอยู่ในกล่อง ลองส่งอีกครั้งเมื่อเน็ตกลับมา",
        });
      } else {
        toast.error("ส่งไม่สำเร็จ", { description: msg ?? undefined });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {floating ? (
        <button
          type="button"
          title={unread > 0 ? "มีคำตอบจากทีมงาน" : "ส่งฟีดแบค / แจ้งปัญหา"}
          onClick={() => setOpen(true)}
          className="no-print fixed bottom-4 right-4 z-40 inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg transition hover:opacity-90 active:scale-95"
        >
          <Bug className="h-4 w-4" />
          แจ้งปัญหา
          {unread > 0 && (
            <span
              data-testid="feedback-unread-dot"
              className="absolute -right-0.5 -top-0.5 flex h-3 w-3 rounded-full bg-destructive ring-2 ring-background"
            />
          )}
        </button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          title="ส่งฟีดแบค / แจ้งปัญหา"
          onClick={() => setOpen(true)}
          className="relative"
        >
          <MessageSquarePlus className="h-4 w-4" />
          {unread > 0 && (
            <span
              data-testid="feedback-unread-dot"
              className="absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive"
            />
          )}
          <span className="sr-only">ส่งฟีดแบค</span>
        </Button>
      )}

      {/* NOT gated on `busy`. While an attachment was uploading, this modal sealed
          itself shut — Escape, the overlay and the X all inert, both footer buttons
          disabled — and its overlay covers the entire app, Live Mode included. The
          send button stays disabled so closing cannot double-submit; the upload and
          its toast simply finish in the background. */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>ส่งฟีดแบค / แจ้งปัญหา</DialogTitle>
            <DialogDescription>
              เจอบั๊ก อยากได้อะไรเพิ่ม หรือใช้แล้วติดตรงไหน บอกได้เลย — ทีมจะเอาไปพัฒนาต่อ
            </DialogDescription>
          </DialogHeader>

          {/* Plain buttons rather than Radix Tabs: this dialog is mounted OUTSIDE
              the app's providers in both shells, and the fewer contexts it needs
              the fewer ways it can white-screen the desktop app. */}
          <div className="flex gap-1 rounded-lg bg-muted p-1 text-sm">
            <button
              type="button"
              onClick={() => setTab("new")}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 transition-colors",
                tab === "new" ? "bg-background font-medium shadow-sm" : "text-muted-foreground"
              )}
            >
              ส่งใหม่
            </button>
            <button
              type="button"
              data-testid="feedback-tab-mine"
              onClick={() => setTab("mine")}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 transition-colors",
                tab === "mine" ? "bg-background font-medium shadow-sm" : "text-muted-foreground"
              )}
            >
              ที่ส่งไปแล้ว
              {unread > 0 && (
                <Badge variant="destructive" className="ml-1.5">
                  {unread}
                </Badge>
              )}
            </button>
          </div>

          {tab === "new" ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>ประเภท</Label>
                <div className="flex flex-wrap gap-2">
                  {CATS.map((c) => {
                    const Icon = c.icon;
                    return (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => setCategory(c.value)}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors",
                          category === c.value
                            ? "border-primary bg-primary/10 font-medium"
                            : "text-muted-foreground hover:bg-muted"
                        )}
                      >
                        <Icon className="h-4 w-4" /> {c.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fb-msg">รายละเอียด</Label>
                <textarea
                  id="fb-msg"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={5}
                  placeholder="อธิบายสั้น ๆ ก็ได้ครับ เช่น กดปุ่มนี้แล้วเสียงไม่เล่น…"
                  // the one raw textarea in the app, so it needs the 16px-on-phones
                  // rule components/ui/textarea.tsx carries — and this is the field
                  // people type into FROM a phone, to report the bug they just hit
                  className="w-full rounded-md border bg-background p-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label>รูปประกอบ (ไม่บังคับ)</Label>
                <div className="flex flex-wrap items-center gap-2">
                  {files.map((f) => (
                    <div key={`${f.name}-${f.size}-${f.lastModified}`} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element -- local
                          blob preview; next/image cannot take one and does not exist
                          in the Electron renderer this file also runs in. */}
                      <img
                        src={previewUrl(f)}
                        alt={f.name}
                        className="h-20 w-20 rounded-md border object-cover"
                      />
                      <button
                        type="button"
                        title="เอารูปนี้ออก"
                        onClick={() => removeFile(f)}
                        className="absolute -right-1.5 -top-1.5 rounded-full bg-destructive p-0.5 text-destructive-foreground shadow"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  {files.length < MAX_IMAGES && (
                    <button
                      type="button"
                      data-testid="feedback-add-image"
                      onClick={() => fileInput.current?.click()}
                      className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-xs text-muted-foreground transition-colors hover:bg-muted"
                    >
                      <ImagePlus className="h-4 w-4" />
                      แนบรูป
                    </button>
                  )}
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      addFiles(e.target.files);
                      e.target.value = ""; // so the same file can be picked again
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  แนบหน้าที่เปิดอยู่ + รุ่นแอปให้อัตโนมัติ เพื่อให้แก้ได้ตรงจุด · รูปได้สูงสุด {MAX_IMAGES} รูป
                </p>
              </div>
            </div>
          ) : (
            <MyFeedbackList
              key={listRev}
              userId={userId}
              onSeen={(n) => setUnread((u) => Math.max(0, u - n))}
            />
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {tab === "mine" ? "ปิด" : busy ? "ปิดหน้าต่าง" : "ยกเลิก"}
            </Button>
            {tab === "new" && (
              <Button onClick={submit} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <MessageSquarePlus className="h-4 w-4" />
                )}
                ส่ง
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
