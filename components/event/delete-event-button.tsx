"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

/**
 * Delete an event (with a confirm step — there is no undo). Event-scoped rows
 * (schedule / setlist / mic / lineup / versions) cascade away with it; library
 * songs + their audio are NOT touched (audio lives on the song, not the event).
 * RLS limits this to the band's editor (admin or the band's Ar).
 */
export function DeleteEventButton({
  eventId,
  eventName,
}: {
  eventId: string;
  eventName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  function openConfirm(e: React.MouseEvent) {
    e.preventDefault(); // the card is a <Link> — don't navigate
    e.stopPropagation();
    setOpen(true);
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    const supabase = createClient();
    try {
      const { error } = await supabase.from("events").delete().eq("id", eventId);
      if (error) throw error;
      toast.success("ลบงานแล้ว");
      setOpen(false);
      setBusy(false);
      router.refresh();
    } catch (err) {
      toast.error("ลบงานไม่สำเร็จ", {
        description: err instanceof Error ? err.message : undefined,
      });
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={openConfirm}
        title="ลบงานนี้"
        className="absolute bottom-2 right-12 z-10 flex h-8 w-8 items-center justify-center rounded-md border bg-background/80 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition hover:text-destructive focus:opacity-100 group-hover:opacity-100"
      >
        <Trash2 className="h-4 w-4" />
      </button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>ลบงานนี้?</DialogTitle>
            <DialogDescription>
              จะลบ “{eventName}” อย่างถาวร — รวมคิว / เซ็ตลิสต์ / ไมค์ของงานนี้ (กู้คืนไม่ได้)
              ไฟล์เพลงในคลังไม่ถูกลบ
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              ยกเลิก
            </Button>
            <Button variant="destructive" onClick={remove} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              ลบงาน
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
