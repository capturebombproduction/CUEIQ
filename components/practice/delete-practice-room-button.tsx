"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ellipsis, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { wroteNothing, noRowsMessage } from "@/lib/write-guard";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Delete a practice room (type-to-confirm — there is no undo). Room-scoped rows
 * (its practice list / notes / attendance) cascade away with it; library songs +
 * their audio are NOT touched. RLS limits this to the band's editor (admin or Ar).
 * The guard matches DeleteEventButton: this wipes the band's whole training history
 * for the room, and on a phone the trash icon sits right next to "เข้าซ้อม".
 */
export function DeletePracticeRoomButton({
  roomId,
  roomName,
  variant = "icon",
}: {
  roomId: string;
  roomName: string;
  /** "menu": a ⋯ that opens a sheet holding the delete (the Training list) */
  variant?: "icon" | "menu";
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  async function onClick() {
    if (busy) return;
    const ok = await confirm({
      title: "ลบห้องซ้อมนี้?",
      description:
        `จะลบ “${roomName}” อย่างถาวร — รวมลิสต์เพลงซ้อม / บันทึกการซ้อม / การบ้านที่ยังค้าง / เช็คชื่อ / ประวัติการซ้อมทั้งหมดของห้องนี้ (กู้คืนไม่ได้)\nไฟล์เพลงในคลังไม่ถูกลบ`,
      confirmText: "ลบห้องซ้อม",
      requireTyped: roomName,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { data, error } = await createClient()
        .from("events")
        .delete()
        .eq("id", roomId)
        .select("id");
      if (error) throw error;
      // 0 rows = the delete reached the server and removed nothing — RLS mismatch
      // or an anon-key fallback after a stale session, not a room that's actually
      // gone. This wipes a band's whole training history; it must not say so
      // unless a row really left the table. See lib/write-guard.ts.
      if (wroteNothing(data)) {
        toast.error("ลบห้องซ้อมไม่สำเร็จ", { description: await noRowsMessage() });
        return;
      }
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

  if (variant === "menu") {
    // The room's ⋯ (spec §G.6): the delete lives one tap further away than the
    // row, as a dashed destructive-outline, and opens the type-to-confirm sheet.
    // The menu sheet closes first so the two never stack.
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`ตัวเลือกห้องซ้อม ${roomName}`}
          title="ตัวเลือกห้องซ้อม"
          className="shrink-0 text-muted-foreground"
          onClick={() => setMenuOpen(true)}
          disabled={busy}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ellipsis className="h-5 w-5" />}
        </Button>
        <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
          {/* closing to hand over to the confirm sheet: don't pull focus back to
              the ⋯ underneath it */}
          <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
            <DialogHeader>
              {/* the room's own name, as typed: no caps, no italic */}
              <DialogTitle className="font-sans text-xl font-semibold normal-case not-italic leading-snug tracking-normal">
                {roomName}
              </DialogTitle>
              <DialogDescription>ห้องซ้อม · ลบแล้วกู้คืนไม่ได้</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="destructive-outline"
                onClick={() => {
                  setMenuOpen(false);
                  void onClick();
                }}
              >
                <Trash2 className="h-4 w-4" /> ลบห้องซ้อม
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
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
