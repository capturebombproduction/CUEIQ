import { Link } from "react-router-dom";
import { Music2 } from "lucide-react";
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
        {/* Show-must-go-on escape hatch: play local files with no account at all
            (a fresh machine at a no-internet venue can still run the set). */}
        <Link
          to="/emergency"
          className="flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground hover:text-primary hover:underline"
        >
          <Music2 className="h-3.5 w-3.5" />
          โหมดฉุกเฉิน — เปิดเพลงจากไฟล์ในเครื่อง (ไม่ต้องเข้าสู่ระบบ)
        </Link>
      </div>
    </div>
  );
}
