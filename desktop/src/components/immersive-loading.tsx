// The loading placeholder of the two immersive desktop routes — Live Mode and the
// live show-caller. The shell draws no header there (no nav, no Quick Show) and the
// .exe has no back button, while a venue network that is joined but black-holed holds
// this screen for the loaders' whole budget (event-bundle: 8 s, up to 8 s + 20 s;
// the run order: 8 s per read). Before the redesign the header stayed clickable
// through all of it; now the placeholder carries the way out itself: back to the
// event, or Quick Show — the runner that needs neither network nor login.
import { Link } from "react-router-dom";
import { ChevronLeft, Play } from "lucide-react";

const LINK =
  "inline-flex h-11 items-center gap-1 rounded-[3px] px-2 text-sm hover:underline";

export function ImmersiveLoading({
  eventId,
  label,
}: {
  eventId: string | undefined;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-16 text-center text-sm text-muted-foreground">
      <p>{label}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {eventId && (
          <Link to={`/events/${eventId}`} className={`${LINK} text-muted-foreground hover:text-foreground`}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
            กลับ
          </Link>
        )}
        <Link to="/my-show" className={`${LINK} text-primary-ink`}>
          <Play className="h-3.5 w-3.5" aria-hidden />
          Quick Show
        </Link>
      </div>
    </div>
  );
}
