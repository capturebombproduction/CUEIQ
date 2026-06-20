"use client";

import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Self-service password change for the logged-in user. Accounts use synthetic
 * @cueiq.local emails so there's no email-based reset — this is the only way a
 * user can change a password an admin handed them, without involving an admin.
 * The current password is re-verified (re-auth) before the change so an
 * unattended open session can't be used to silently take over the account.
 */
export function ChangePasswordButton() {
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  function clear() {
    setCur("");
    setNext("");
    setConfirm("");
  }

  async function submit() {
    if (cur.length === 0) {
      toast.error("ใส่รหัสผ่านปัจจุบัน");
      return;
    }
    if (next.length < 8) {
      toast.error("รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร");
      return;
    }
    if (next !== confirm) {
      toast.error("รหัสผ่านใหม่กับการยืนยันไม่ตรงกัน");
      return;
    }
    if (next === cur) {
      toast.error("รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม");
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user?.email) throw new Error("ไม่พบบัญชีผู้ใช้ — ลองเข้าสู่ระบบใหม่");
      // verify the CURRENT password by re-authenticating before allowing a change
      const { error: vErr } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: cur,
      });
      if (vErr) throw new Error("รหัสผ่านปัจจุบันไม่ถูกต้อง");
      const { error: uErr } = await supabase.auth.updateUser({ password: next });
      if (uErr) throw new Error(uErr.message);
      toast.success("เปลี่ยนรหัสผ่านแล้ว — ครั้งต่อไปใช้รหัสใหม่");
      clear();
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        title="เปลี่ยนรหัสผ่าน"
        onClick={() => {
          clear();
          setOpen(true);
        }}
      >
        <KeyRound className="h-4 w-4" />
        <span className="sr-only">เปลี่ยนรหัสผ่าน</span>
      </Button>

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>เปลี่ยนรหัสผ่าน</DialogTitle>
            <DialogDescription>
              ยืนยันรหัสผ่านปัจจุบัน แล้วตั้งรหัสผ่านใหม่
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cur-pw">รหัสผ่านปัจจุบัน</Label>
              <Input
                id="cur-pw"
                type="password"
                autoComplete="current-password"
                value={cur}
                onChange={(e) => setCur(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-pw">รหัสผ่านใหม่</Label>
              <Input
                id="new-pw"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="อย่างน้อย 8 ตัว"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-pw">ยืนยันรหัสผ่านใหม่</Label>
              <Input
                id="confirm-pw"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              ยกเลิก
            </Button>
            <Button onClick={submit} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              เปลี่ยนรหัสผ่าน
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
