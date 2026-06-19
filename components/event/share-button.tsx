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
}: {
  eventId: string;
  initialToken: string | null;
}) {
  const [token, setToken] = useState<string | null>(initialToken);
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
    toast.success(enabled ? "เปิดลิงก์แชร์แล้ว" : "ปิดลิงก์แชร์แล้ว");
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
