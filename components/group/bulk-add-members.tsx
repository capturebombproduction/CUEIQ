"use client";

import { useState } from "react";
import { UserPlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Paste a whole roster at once instead of clicking "add member" per person.
 * One member per line; optional nickname + mic number separated by commas:
 *   Yuki, ยูกิ, 1
 */
export function BulkAddMembers({
  onAdd,
}: {
  onAdd: (text: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await onAdd(text);
      setText("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="mt-1">
          <UserPlus className="h-4 w-4" /> เพิ่มหลายคน
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>เพิ่มสมาชิกหลายคน</DialogTitle>
          <DialogDescription>
            พิมพ์บรรทัดละ 1 คน — ใส่ชื่อเล่นและเบอร์ไมค์ได้ คั่นด้วยคอมมา: ชื่อ, ชื่อเล่น, เบอร์ไมค์
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder={"Yuki, ยูกิ, 1\nCherrie, เชอร์รี่, 2\nRiko"}
        />
        <Button onClick={submit} disabled={busy || !text.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          เพิ่มทั้งหมด
        </Button>
      </DialogContent>
    </Dialog>
  );
}
