import { toast } from "sonner";
import type { createClient } from "@/lib/supabase/client";
import type { useConfirm } from "@/components/ui/confirm-dialog";
import type { CloneResult } from "@/lib/clone-event";
import { wroteNothing, noRowsMessage } from "@/lib/write-guard";

/**
 * What the person is told once a clone has created its event — shared by
 * "ก๊อปงาน" and "สร้างจากแม่แบบ" so the two can never again disagree about
 * what a half-finished copy looks like. (They did: see lib/clone-event.ts.)
 *
 *  • everything copied → open the new show;
 *  • every part that had rows failed → the event is an empty ghost carrying the
 *    source's name, so offer to remove it, and only report it gone if a row
 *    really left the table (lib/write-guard.ts);
 *  • some parts copied → the show has real content and stays; name what's missing.
 *
 * Returns true when the person was taken to the new show (the caller's busy
 * state goes with the page), false when they stay where they are.
 */
export async function reportClone(
  result: CloneResult,
  {
    name,
    supabase,
    confirm,
    open,
    text,
  }: {
    name: string;
    supabase: ReturnType<typeof createClient>;
    confirm: ReturnType<typeof useConfirm>;
    open: (eventId: string) => void;
    text: { success: string; failed: string; partial: string };
  }
): Promise<boolean> {
  const { newId, failed, attempted } = result;
  const parts = failed.join(", ");

  if (failed.length === 0) {
    toast.success(text.success);
    open(newId);
    return true;
  }

  if (failed.length === attempted) {
    const remove = await confirm({
      title: text.failed,
      description: `คัดลอกไม่สำเร็จทั้งหมด (${parts}) งาน “${name}” ที่สร้างไว้จึงว่างเปล่า — ลบงานว่างนี้ทิ้งไหม?`,
      confirmText: "ลบงานว่างนี้",
      cancelText: "เก็บไว้",
    });
    if (!remove) {
      toast.error(text.failed, {
        description: `สร้างงาน “${name}” ไว้แล้วแต่ยังไม่มี${failed.join("/")} — เปิดงานแล้วสร้างเองได้`,
      });
      open(newId);
      return true;
    }
    const { data, error } = await supabase
      .from("events")
      .delete()
      .eq("id", newId)
      .select("id");
    if (error || wroteNothing(data)) {
      toast.error("สร้างงานไม่สำเร็จ และลบงานว่างไม่สำเร็จ", {
        description: error ? error.message : await noRowsMessage(),
      });
      open(newId);
      return true;
    }
    toast.error(`${text.failed} — ลบงานว่างที่สร้างไว้แล้ว`);
    return false;
  }

  toast.error(text.partial, {
    description: `สร้างงาน “${name}” แล้ว แต่คัดลอกไม่สำเร็จ: ${parts} — เปิดงานแล้วเพิ่มส่วนที่ขาดเองได้`,
  });
  open(newId);
  return true;
}
