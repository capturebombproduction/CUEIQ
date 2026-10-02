import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";

/** The Quick Show entry on every screen that has no shell around it — sign-in, the
 *  boot screen, the shell's loading / failed fallback and the event page's "could not
 *  be reached" dead end. It is the one door that needs neither network nor account
 *  (the fully-local standalone show runner), so each of those screens offers it, and
 *  it used to be copied four times: only the sign-in's copy followed the redesign.
 *  A square slab with the band's colour on its left edge, as the web's cards. */
export function QuickShowLink({ className }: { className?: string }) {
  return (
    <Link
      to="/my-show"
      data-testid="quick-show-link"
      className={cn(
        "group flex min-h-[64px] items-center gap-3 rounded-[3px] bg-card px-4 py-3 shadow-[inset_0_0_0_1px_hsl(var(--border)),inset_3px_0_0_hsl(var(--primary))] transition-colors duration-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
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
  );
}
