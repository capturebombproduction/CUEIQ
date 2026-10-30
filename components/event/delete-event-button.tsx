"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { noRowsMessage, wroteNothing } from "@/lib/write-guard";

/** How long the festival-board count below may hold the confirm back. */
const BOARD_LINES_TIMEOUT_MS = 3000;

/**
 * How many festival running-order lines are linked to this event, or null when that
 * could not be learned in time (2026-10-30, hunt 11). Deleting the event does NOT
 * remove them - run_sequence.linked_event_id is `on delete set null` (0033) - so the
 * band's line stayed on the board, unlinked, and the caller still called a band that
 * had been taken off the show; the dialog never said so. Re-adding the band later then
 * gave it a second line (นำเข้าจากเวทีวง skips unlinked lines). It only adds a sentence,
 * so it never throws and never waits long: failure, a slow answer, or an anon read's
 * 0 all mean "say nothing", and the delete is unchanged.
 */
async function boardLinesOf(
  supabase: ReturnType<typeof createClient>,
  eventId: string
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = Promise.resolve(
      supabase
        .from("run_sequence")
        .select("id", { count: "exact", head: true })
        .eq("linked_event_id", eventId)
    ).then(({ count, error }) => (error ? null : (count ?? null)));
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), BOARD_LINES_TIMEOUT_MS);
    });
    return await Promise.race([read, late]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
    const supabase = createClient();
    // the spinner while the board is asked (≤ BOARD_LINES_TIMEOUT_MS), so a slow
    // venue network does not look like a dead button
    setBusy(true);
    const lines = await boardLinesOf(supabase, eventId);
    setBusy(false);
    const ok = await confirm({
      title: "ลบงานนี้?",
      description:
        `จะลบ “${eventName}” อย่างถาวร — รวมคิว / เซ็ตลิสต์ / ไมค์ของงานนี้ (กู้คืนไม่ได้)\nไฟล์เพลงในคลังไม่ถูกลบ` +
        (lines
          ? `\nบอร์ดคิวเทศกาลมีลำดับของวงนี้ ${lines} แถว ซึ่งจะไม่ถูกลบไปด้วย — ลบที่ Running Order ด้วย`
          : ""),
      confirmText: "ลบงาน",
      requireTyped: eventName,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { data, error } = await supabase
        .from("events")
        .delete()
        .eq("id", eventId)
        .select("id");
      if (error) throw error;
      // No error and no row = the delete reached the server and removed nothing
      // (sent anon after a failed token refresh, or a band role just taken away —
      // lib/write-guard.ts). Announcing it and dropping the card said the show was
      // gone; it came back on the next refresh, or stayed hidden here until a reload.
      if (wroteNothing(data)) {
        toast.error("ยังไม่ได้ลบงาน", { description: await noRowsMessage() });
        setBusy(false);
        return;
      }
      toast.success("ลบงานแล้ว");
      setBusy(false);
      onDeleted?.(eventId); // drop the card immediately; don't wait for refresh
      router.refresh(); // reconcile with the server in the background
    } catch (err) {
      // `error` above is PostgREST's plain object, not an Error: read its message too, or
      // a refusal (a guard trigger, a network failure) said "ไม่สำเร็จ" with no reason
      toast.error("ลบงานไม่สำเร็จ", {
        description: (err as { message?: string } | null)?.message || undefined,
      });
      setBusy(false);
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      title="ลบงานนี้"
      // See duplicate-event-button: hover-reveal made this unreachable on touch,
      // which meant an event could not be deleted at all from an iPad — this is the
      // only delete control in the app.
      className="absolute bottom-2 right-[56px] z-10 grid h-11 w-11 place-items-center rounded-[2px] bg-muted text-muted-foreground shadow-edge transition hover:text-destructive focus:opacity-100 disabled:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
    </button>
  );
}
