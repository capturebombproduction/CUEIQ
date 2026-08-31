"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, X } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { isLiveShowActive } from "@/lib/live-guard";
import { enablePush, pushAvailability } from "@/lib/push-subscribe";
import { Button } from "@/components/ui/button";

/**
 * "เปิดแจ้งเตือนไหม" — asked once, by the app, instead of waiting to be found.
 *
 * WHY THIS EXISTS, measured rather than guessed. On 2026-08-31 `push_subscriptions`
 * held ONE row, for one account, out of nineteen. The plumbing was never broken:
 * the cron has written 148 reminders, /api/notify works, the VAPID keys are live.
 * The only way to switch push ON was a button INSIDE the notification dropdown, so
 * anyone who never opened the bell never learned it existed — and eighteen people
 * never did. That is why a bug report could sit unanswered for two months and an
 * approval for six weeks: the messages were being written and nobody was being
 * told. A feature nobody can find is a feature that does not exist.
 *
 * THE RESTRAINT MATTERS MORE THAN THE PROMPT. This is a band's show-day tool, and
 * a banner that interrupts at the wrong moment gets dismissed on reflex — after
 * which the real ones are dismissed too, which is the lesson round 14 already paid
 * for once. So it stays quiet unless every one of these is true:
 *
 *   • push is actually available here (a subscription can be made, permission has
 *     not already been refused, and there is not one already) — under Electron
 *     that is never true, because file:// registers no service worker at all;
 *   • NO SHOW IS RUNNING. lib/live-guard.ts is the same flag the sign-out button
 *     and the leave guard consult. Nothing gets to cover the screen while an
 *     operator is running a set;
 *   • this device has not already said "ไว้ก่อน". The memory is per-DEVICE
 *     (localStorage) on purpose and not per-account: a push subscription IS a
 *     property of the device, so a phone that declined should stay quiet even for
 *     a different band member, and the shared iPad should not re-ask nineteen times.
 *
 * It also waits a beat before appearing, so it never lands on top of a page the
 * person is still reading, and it is a bottom bar rather than a modal: nothing it
 * covers is something you were about to press.
 */

const DISMISS_KEY = "cueiq:push-nudge-dismissed";
/** Long enough that the page has settled and the user has chosen what they came to
 *  do; short enough to still be in the same visit. */
const DELAY_MS = 8000;

/** Per-device, and tolerant of a browser that refuses storage entirely (private
 *  windows, and the Electron renderer where this never runs anyway). A storage
 *  failure must leave the nudge SILENT, not stuck on: an un-dismissable banner is
 *  worse than a missing one. */
function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return true;
  }
}
function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Nothing to do — the banner is closing either way, and re-asking next visit
    // on a device that cannot remember is the lesser harm.
  }
}

export function PushNudge({
  userId,
  tenantId,
}: {
  userId: string;
  tenantId: string | null;
}) {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId || wasDismissed()) return;
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        // Re-checked HERE rather than at mount: a show can start during the delay,
        // and the whole point is that this never appears over a running set.
        if (!alive || isLiveShowActive()) return;
        if ((await pushAvailability()) !== "available") return;
        if (alive && !isLiveShowActive()) setShow(true);
      })();
    }, DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [userId]);

  const dismiss = useCallback(() => {
    rememberDismissed();
    setShow(false);
  }, []);

  async function accept() {
    setBusy(true);
    try {
      const res = await enablePush({ supabase: createClient(), userId, tenantId });
      if (res.ok) {
        toast.success("เปิดแจ้งเตือนเด้งบนอุปกรณ์นี้แล้ว 🔔");
      } else if (res.reason === "denied") {
        toast.error("ยังไม่ได้อนุญาตแจ้งเตือน", {
          description: "เปิดทีหลังได้ที่รูปกระดิ่งมุมขวาบน",
        });
      } else if (res.reason === "unsupported") {
        // Nothing to say — availability was checked before showing this, so
        // landing here means the device changed its mind mid-answer.
      } else {
        toast.error("เปิดแจ้งเตือนเด้งไม่สำเร็จ", { description: res.message });
      }
    } finally {
      setBusy(false);
      // Asked and answered, whichever way it went. A device that failed can still
      // try again from the bell; re-asking on every visit is how a prompt becomes
      // something people learn to swat away.
      dismiss();
    }
  }

  if (!show) return null;

  return (
    <div
      data-testid="push-nudge"
      role="region"
      aria-label="เปิดแจ้งเตือน"
      className="no-print fixed inset-x-2 bottom-2 z-50 mx-auto max-w-md rounded-lg border bg-card p-3 shadow-lg sm:inset-x-auto sm:right-4 sm:mx-0"
    >
      <div className="flex items-start gap-3">
        <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">เปิดแจ้งเตือนเด้งไหมครับ</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            จะได้รู้ทันทีเมื่อมีโชว์พรุ่งนี้ งานรออนุมัติ หรือทีมงานตอบฟีดแบคที่คุณแจ้งไว้
            — ไม่ต้องคอยเปิดเว็บเช็คเอง
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={accept} disabled={busy}>
              เปิดเลย
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss} disabled={busy}>
              ไว้ก่อน
            </Button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          disabled={busy}
          title="ปิด"
          aria-label="ปิด"
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
