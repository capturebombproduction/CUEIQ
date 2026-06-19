"use client";

import { useState } from "react";
import { Share2, Copy, Check, Link2Off, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";

// Lets an editor publish a public read-only run-sheet link for the event. The
// link works WITHOUT login — anyone with it reads the run sheet via the
// get_shared_event RPC (see 0005_share_links.sql). Revoking sets the token null.
export function ShareButton({
  eventId,
  initialToken,
  initialExpiresAt,
}: {
  eventId: string;
  initialToken: string | null;
  initialExpiresAt: string | null;
}) {
  const [token, setToken] = useState<string | null>(initialToken);
  const [expiresAt, setExpiresAt] = useState<string | null>(initialExpiresAt);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const link =
    token && typeof window !== "undefined"
      ? `${window.location.origin}/share/${token}`
      : "";

  async function setShare(enabled: boolean) {
    setBusy(true);
    const next = enabled
      ? typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : null
      : null;
    if (enabled && !next) {
      setBusy(false);
      toast.error("สร้างลิงก์ไม่สำเร็จ");
      return;
    }
    const supabase = createClient();
    const { error } = await supabase
      .from("events")
      .update({ share_token: next })
      .eq("id", eventId);
    setBusy(false);
    if (error) {
      toast.error("ทำรายการไม่สำเร็จ", { description: error.message });
      return;
    }
    setToken(next);
    if (!enabled) setExpiresAt(null);
    toast.success(enabled ? "เปิดลิงก์แชร์แล้ว" : "ปิดลิงก์แชร์แล้ว");
  }

  async function setExpiry(days: number | null) {
    const next = days == null ? null : new Date(Date.now() + days * 86400000).toISOString();
    setBusy(true);
    const { error } = await createClient()
      .from("events")
      .update({ share_expires_at: next })
      .eq("id", eventId);
    setBusy(false);
    if (error) {
      toast.error("ตั้งวันหมดอายุไม่สำเร็จ", { description: error.message });
      return;
    }
    setExpiresAt(next);
    toast.success(days == null ? "ตั้งเป็นไม่หมดอายุ" : `หมดอายุใน ${days} วัน`);
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success("คัดลอกลิงก์แล้ว");
    } catch {
      toast.error("คัดลอกไม่สำเร็จ — กดค้างที่ลิงก์เพื่อคัดลอกเอง");
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="lg">
          <Share2 className="h-4 w-4" /> แชร์
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>แชร์ run sheet</DialogTitle>
          <DialogDescription>
            ลิงก์ดูอย่างเดียว เปิดได้โดยไม่ต้องล็อกอิน — เหมาะกับทีมงาน/สถานที่ ใครมีลิงก์ก็เปิดดูได้
          </DialogDescription>
        </DialogHeader>

        {token ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-md border bg-muted/40 px-3 py-2 text-sm"
              />
              <Button type="button" onClick={copy} className="shrink-0">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">
                {expiresAt
                  ? new Date(expiresAt) < new Date()
                    ? "⚠️ ลิงก์หมดอายุแล้ว — ตั้งใหม่ด้านล่าง"
                    : `หมดอายุ ${new Date(expiresAt).toLocaleString("th-TH", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`
                  : "ลิงก์นี้ไม่มีวันหมดอายุ"}
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setExpiry(7)}>
                  7 วัน
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setExpiry(30)}>
                  30 วัน
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setExpiry(null)}>
                  ไม่หมดอายุ
                </Button>
              </div>
            </div>

            <Button
              type="button"
              variant="ghost"
              onClick={() => setShare(false)}
              disabled={busy}
              className="text-destructive hover:text-destructive"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2Off className="h-4 w-4" />}
              ปิดลิงก์ (ลิงก์เดิมจะใช้ไม่ได้)
            </Button>
          </div>
        ) : (
          <Button type="button" onClick={() => setShare(true)} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
            สร้างลิงก์แชร์
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
