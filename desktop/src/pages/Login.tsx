import { LoginForm } from "@/components/auth/login-form";
import { StageLight } from "@/components/stage-light";
import { QuickShowLink } from "~/components/quick-show-link";

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
        <QuickShowLink />
        <p className="pt-5 text-center text-[11px] text-faint">Designed by PatzNutthapat</p>
      </div>
    </div>
  );
}
