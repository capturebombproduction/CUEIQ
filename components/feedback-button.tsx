"use client";

import { useState } from "react";
import { MessageSquarePlus, Loader2, Bug, Lightbulb, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { APP_VERSION } from "@/lib/app-version";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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

/**
 * In-app feedback / bug-report channel — open to EVERY logged-in user (the point
 * is to gather real-use feedback from band members during live shows). Stores into
 * public.feedback with the page + build auto-attached so the team can fix the
 * right spot. Self-contained (Supabase, no external service).
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
  const [category, setCategory] = useState<Category>("bug");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  if (!userId || !tenantId) return null;

  async function submit() {
    const msg = message.trim();
    if (msg.length < 3) {
      toast.error("พิมพ์รายละเอียดสักนิดนะครับ");
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.from("feedback").insert({
        tenant_id: tenantId,
        user_id: userId,
        category,
        message: msg.slice(0, 4000),
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
      toast.success("ส่งฟีดแบคแล้ว — ขอบคุณมากครับ 🙏");
      setMessage("");
      setCategory("bug");
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "ส่งไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {floating ? (
        <button
          type="button"
          title="ส่งฟีดแบค / แจ้งปัญหา"
          onClick={() => setOpen(true)}
          className="no-print fixed bottom-4 right-4 z-40 inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg transition hover:opacity-90 active:scale-95"
        >
          <Bug className="h-4 w-4" />
          แจ้งปัญหา
        </button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          title="ส่งฟีดแบค / แจ้งปัญหา"
          onClick={() => setOpen(true)}
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span className="sr-only">ส่งฟีดแบค</span>
        </Button>
      )}

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ส่งฟีดแบค / แจ้งปัญหา</DialogTitle>
            <DialogDescription>
              เจอบั๊ก อยากได้อะไรเพิ่ม หรือใช้แล้วติดตรงไหน บอกได้เลย — ทีมจะเอาไปพัฒนาต่อ
            </DialogDescription>
          </DialogHeader>

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
                className="w-full rounded-md border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                แนบหน้าที่เปิดอยู่ + รุ่นแอปให้อัตโนมัติ เพื่อให้แก้ได้ตรงจุด
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              ยกเลิก
            </Button>
            <Button onClick={submit} disabled={busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <MessageSquarePlus className="h-4 w-4" />
              )}
              ส่ง
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
