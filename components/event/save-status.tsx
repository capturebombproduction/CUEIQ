"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CloudOff, Loader2 } from "lucide-react";
import { markAbandoned, markPending, markSettled } from "@/lib/dirty-guard";
import { cn } from "@/lib/utils";

/**
 * "Did that save?" — answered on screen.
 *
 * WHY THIS EXISTS. The setlist builder and the schedule editor have autosaved on
 * every blur since 2026-06-16, and NOTHING has ever said so. Two of the five
 * pieces of feedback the label sent through the in-app channel are that gap, in
 * the user's own words (2026-08-13): "อยากให้บันทึกการแก้ไขไว้ตั้งแต่ไม่ต้องกดบันทึก"
 * — a request for the feature the app already had — and "เวลาที่มีการแก้ไข แล้วจะ
 * เปลี่ยนหน้าไปหน้าอื่น อยากให้มีการเตือนว่า ยังไม่ได้บันทึก". Both come from the
 * same place: work that vanished into a form with no receipt. The fix is not a
 * save button. It is telling the truth about the save that already happened.
 *
 * The "saved" state DOES NOT time out. A badge that fades after three seconds is
 * for reassuring someone who is watching; this is for someone who looked away,
 * typed the last cue, and is deciding whether it is safe to close the laptop.
 */
export type SaveState = "idle" | "saving" | "saved" | "failed";

export function useSaveSignal() {
  const [state, setState] = useState<SaveState>("idle");
  // Counted, not a boolean: a reorder fires N updates at once (Promise.all), and
  // the first one to land would otherwise flip the whole row to "saved" while the
  // rest are still in flight — the exact false receipt this component exists to
  // stop giving.
  const inFlight = useRef(0);

  const begin = useCallback(() => {
    inFlight.current += 1;
    // The same write is reported to lib/dirty-guard.ts, which is what the
    // leave-the-page warning reads. It is module-level on purpose: this hook's
    // state dies when EventWorkspace re-keys a hidden tab, and the warning must
    // not die with it.
    markPending();
    setState("saving");
  }, []);

  const end = useCallback((ok: boolean) => {
    inFlight.current = Math.max(0, inFlight.current - 1);
    markSettled(ok);
    // A failure wins over anything still in flight and stays put: the toast that
    // accompanies it is gone in seconds, and what is on screen afterwards has to
    // keep saying that something did not land.
    setState((prev) => (!ok || prev === "failed" ? "failed" : inFlight.current > 0 ? "saving" : "saved"));
  }, []);

  // An editor that unmounts mid-write (a tab re-key, or a navigation the guard
  // already asked about) would otherwise leave its begin() counted forever, and
  // every later exit would warn about a write nobody is waiting for.
  useEffect(() => {
    return () => {
      markAbandoned(inFlight.current);
      inFlight.current = 0;
    };
  }, []);

  /** Wrap one write. Returns whatever the write returned. */
  const track = useCallback(
    async <T,>(write: () => Promise<T>, succeeded: (result: T) => boolean): Promise<T> => {
      begin();
      try {
        const result = await write();
        end(succeeded(result));
        return result;
      } catch (e) {
        end(false);
        throw e;
      }
    },
    [begin, end]
  );

  return { state, begin, end, track };
}

export function SaveStatus({ state, className }: { state: SaveState; className?: string }) {
  if (state === "idle") return null;
  const map = {
    saving: { icon: Loader2, text: "กำลังบันทึก…", tone: "text-muted-foreground", spin: true },
    saved: { icon: Check, text: "บันทึกแล้ว", tone: "text-success", spin: false },
    failed: { icon: CloudOff, text: "ยังไม่ได้บันทึก", tone: "text-destructive", spin: false },
  } as const;
  const { icon: Icon, text, tone, spin } = map[state];
  return (
    <span
      data-testid="save-status"
      data-save-state={state}
      // aria-live so a screen reader hears the receipt too — this is a status, not
      // a decoration, and it changes without the user doing anything to it.
      aria-live="polite"
      className={cn("inline-flex items-center gap-1 text-xs font-medium", tone, className)}
    >
      <Icon className={cn("h-3.5 w-3.5", spin && "animate-spin")} />
      {text}
    </span>
  );
}
