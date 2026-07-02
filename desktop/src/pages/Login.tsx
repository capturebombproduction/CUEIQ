import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import { LoginForm } from "@/components/auth/login-form";

/** Mirrors the web login: the same LoginForm component (reused verbatim) centered
 *  with the CueIQ wordmark. Same Supabase auth → same accounts as the web app. */
export function Login() {
  return (
    <div className="grid min-h-screen place-items-center bg-muted/30 p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-primary">CueIQ</h1>
          <p className="mt-1 text-sm text-muted-foreground">Desktop · Smart cues for every show</p>
        </div>
        <LoginForm />
        {/* Show-must-go-on: the fully-local standalone show runner — no account,
            no network, everything saved on this machine (Live-Mode-grade clock). */}
        <Link
          to="/my-show"
          className="group flex items-center gap-3 rounded-xl border-2 border-primary/40 bg-primary/5 px-4 py-3 shadow-sm transition-colors hover:border-primary/70 hover:bg-primary/10"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary transition-colors group-hover:bg-primary/25">
            <Play className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-primary">Quick Show</span>
            <span className="block text-xs text-muted-foreground">
              โหมดโชว์เดี่ยว — เปิดเพลง+จับเวลาจากเครื่องนี้ ไม่ต้องเข้าสู่ระบบ
            </span>
          </span>
        </Link>
      </div>
    </div>
  );
}
