import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import { LoginForm } from "@/components/auth/login-form";
import { StageLight } from "@/components/stage-light";

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
        {/* Show-must-go-on: the fully-local standalone show runner — no account,
            no network, everything saved on this machine (Live-Mode-grade clock). */}
        <Link
          to="/my-show"
          className="group flex min-h-[64px] items-center gap-3 rounded-[3px] bg-card px-4 py-3 shadow-[inset_0_0_0_1px_hsl(var(--border)),inset_3px_0_0_hsl(var(--primary))] transition-colors duration-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[2px] bg-primary text-primary-foreground">
            <Play className="h-5 w-5" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="caps block text-[17px] leading-none">Quick Show</span>
            <span className="mt-1 block text-[12.5px] text-muted-foreground">
              โหมดโชว์เดี่ยว — เปิดเพลง+จับเวลาจากเครื่องนี้ ไม่ต้องเข้าสู่ระบบ
            </span>
          </span>
        </Link>
        <p className="pt-5 text-center text-[11px] text-faint">Designed by PatzNutthapat</p>
      </div>
    </div>
  );
}
