import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { LoginForm } from "@/components/auth/login-form";
import { StageLight } from "@/components/stage-light";
import { QuickShowLink } from "~/components/quick-show-link";
import { MGMT_OUTBOX_EVENT, queuedMgmtWorkCount } from "~/data/mgmt-outbox";

/** Venue work still on this machine when nobody is signed in. A deliberate sign-out
 *  wipes it (after asking), so anything left here belongs to a session that died on
 *  its own — revoked from another device, or refused by a venue's captive portal.
 *  It goes out only when that SAME account signs back in, so say so before the
 *  person types someone else's name. Same amber as the shell's "ค้างซิงค์" chip. */
function QueuedWorkNotice() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      queuedMgmtWorkCount()
        .then((n) => {
          if (alive) setCount(n);
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener(MGMT_OUTBOX_EVENT, refresh);
    return () => {
      alive = false;
      window.removeEventListener(MGMT_OUTBOX_EVENT, refresh);
    };
  }, []);
  if (count === 0) return null;
  return (
    <p
      role="status"
      data-testid="queued-work-notice"
      className="flex items-start gap-2 rounded-[3px] bg-amber-500/10 px-4 py-3 text-[12.5px] text-amber-600 ring-1 ring-amber-500/40 dark:text-amber-400"
    >
      <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        มีงานค้างซิงค์ {count} รายการในเครื่องนี้ — เข้าสู่ระบบด้วยบัญชีเดิมเพื่อส่งขึ้นออนไลน์
      </span>
    </p>
  );
}

/** Mirrors the web login: the same LoginForm slab (reused verbatim) centred on the
 *  dark stage, under the same page light. Same Supabase auth → same accounts as the
 *  web app. */
export function Login() {
  return (
    // data-cueiq-screen — see the note on App.tsx's BootScreen. relative isolate:
    // the light (z-index -1) paints over this screen's background, under the slab.
    <div
      data-cueiq-screen="login"
      className="relative isolate grid min-h-screen place-items-center bg-background p-4"
    >
      <StageLight />
      <div className="w-full max-w-sm space-y-3">
        <LoginForm subtitle="Desktop · ระบบคิวโชว์ของค่าย — เข้าด้วยชื่อผู้ใช้ที่แอดมินสร้างให้" />
        <QueuedWorkNotice />
        {/* Show-must-go-on: the fully-local standalone show runner — no account,
            no network, everything saved on this machine (Live-Mode-grade clock). */}
        <QuickShowLink />
        <p className="pt-5 text-center text-[11px] text-faint">Designed by PatzNutthapat</p>
      </div>
    </div>
  );
}
