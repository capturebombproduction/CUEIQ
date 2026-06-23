"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useConfirm } from "@/components/ui/confirm-dialog";

/**
 * Delete an event (type-to-confirm — there is no undo). Event-scoped rows
 * (schedule / setlist / mic / lineup / versions) cascade away with it; library
 * songs + their audio are NOT touched (audio lives on the song, not the event).
 * RLS limits this to the band's editor (admin or the band's Ar).
 */
export function DeleteEventButton({
  eventId,
  eventName,
  onDeleted,
}: {
  eventId: string;
  eventName: string;
  /** Optimistically drop the card from the list before the server refresh. */
  onDeleted?: (id: string) => void;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  async function onClick(e: React.MouseEvent) {
    e.preventDefault(); // the card is a <Link> — don't navigate
    e.stopPropagation();
    if (busy) return;
    const ok = await confirm({
      title: "ลบงานนี้?",
      description:
        `จะลบ “${eventName}” อย่างถาวร — รวมคิว / เซ็ตลิสต์ / ไมค์ของงานนี้ (กู้คืนไม่ได้)\nไฟล์เพลงในคลังไม่ถูกลบ`,
      confirmText: "ลบงาน",
      requireTyped: eventName,
    });
    if (!ok) return;
    setBusy(true);
    const supabase = createClient();
    try {
      const { error } = await supabase.from("events").delete().eq("id", eventId);
      if (error) throw error;
      toast.success("ลบงานแล้ว");
      setBusy(false);
      onDeleted?.(eventId); // drop the card immediately; don't wait for refresh
      router.refresh(); // reconcile with the server in the background
    } catch (err) {
      toast.error("ลบงานไม่สำเร็จ", {
        description: err instanceof Error ? err.message : undefined,
      });
      setBusy(false);
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      title="ลบงานนี้"
      className="absolute bottom-2 right-12 z-10 flex h-8 w-8 items-center justify-center rounded-md border bg-background/80 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition hover:text-destructive focus:opacity-100 group-hover:opacity-100"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
    </button>
  );
}
