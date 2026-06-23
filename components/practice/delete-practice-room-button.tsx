"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";

/**
 * Delete a practice room (a confirm step — there is no undo). Room-scoped rows
 * (its practice list / notes / attendance) cascade away with it; library songs +
 * their audio are NOT touched. RLS limits this to the band's editor (admin or Ar).
 */
export function DeletePracticeRoomButton({
  roomId,
  roomName,
}: {
  roomId: string;
  roomName: string;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (busy) return;
    const ok = await confirm({
      title: "ลบห้องซ้อมนี้?",
      description:
        `จะลบ “${roomName}” อย่างถาวร — รวมลิสต์เพลงซ้อม / บันทึกการซ้อมในห้องนี้ (กู้คืนไม่ได้)\nไฟล์เพลงในคลังไม่ถูกลบ`,
      confirmText: "ลบห้องซ้อม",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { error } = await createClient().from("events").delete().eq("id", roomId);
      if (error) throw error;
      toast.success("ลบห้องซ้อมแล้ว");
      router.refresh();
    } catch (err) {
      toast.error("ลบห้องซ้อมไม่สำเร็จ", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      title="ลบห้องซ้อมนี้"
      className="shrink-0 text-muted-foreground hover:text-destructive"
      onClick={onClick}
      disabled={busy}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
    </Button>
  );
}
