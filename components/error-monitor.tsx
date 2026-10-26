"use client";

import { Component, useEffect, useLayoutEffect, type ReactNode } from "react";
import { logClientError } from "@/lib/client-log";
import { Button } from "@/components/ui/button";
import { FeedbackButton } from "@/components/feedback-button";
import { immersiveEventId } from "@/components/chrome-gate";

/** A FULL load of `target`: a crashed class boundary never resets on a route change.
 *  The desktop (a HashRouter) sets the hash and reloads into it — the Quick Show
 *  escape in desktop/src/main.tsx does the same; the web navigates for real. */
function leaveTo(target: string, hashRouter: boolean) {
  if (hashRouter) {
    window.location.hash = `#${target}`;
    window.location.reload();
  } else {
    window.location.assign(target);
  }
}

/** One CSP violation, as the root layout's pre-paint buffer stores it. */
type CspViolation = { d?: string; b?: string; s?: string; l?: number; x?: string };

/** Origin + path only: a refused presigned R2 URL carries its signature in the
 *  query, and that has no business in client_errors. "inline" / "eval" / "data"
 *  are not URLs and pass through. */
function noQuery(u: string | undefined): string {
  if (!u) return "";
  try {
    const url = new URL(u);
    return url.origin + url.pathname;
  } catch {
    return u.slice(0, 200);
  }
}

export function cspMessage(v: CspViolation): string {
  return `CSP ${v.d || "?"} blocked ${noQuery(v.b) || "?"}`;
}

/** Who a render crash caught by the in-app error card is reported as - set by the
 *  ErrorMonitor the (app) layout mounts, and kept after it unmounts (see there); null
 *  until one has mounted (a crash before sign-in reports nothing). */
let reporter: { userId: string; tenantId: string | null } | null = null;

/**
 * Record a render crash that Next's own boundary caught. On the web every page
 * sits inside app/(app)/error.tsx's boundary, which is nested INSIDE the layout's
 * AppErrorBoundary - so the page crash never reached componentDidCatch below, and
 * Next reports a caught error with console.error only: web white-screens (Live
 * Mode's included) left nothing in the Dev Inbox. components/error-card.tsx calls this.
 */
export function reportCaughtRenderError(error: Error & { digest?: string }) {
  if (!reporter) return;
  // The digest goes IN the message (2026-10-27): it is the only link from a server crash
  // to its Vercel log line, and in a production browser the message is the same "Minified
  // React error #441…" for every one of them - and the stack is never empty, so a digest
  // kept for an empty stack was never kept at all. client-log dedupes on the message, so
  // with the digest in it a second, different server crash in the tab is still recorded.
  const msg = error?.message || "render crash";
  void logClientError({
    ...reporter,
    kind: "react",
    message: error?.digest ? `${msg} [digest ${error.digest}]` : msg,
    stack: error?.stack ?? null,
  });
}

/**
 * Global client-error capture. Mounted once in the (app) layout. Installs window
 * 'error' + 'unhandledrejection' listeners that forward to logClientError
 * (deduped/throttled/self-silencing). Renders nothing.
 */
export function ErrorMonitor({
  userId,
  tenantId,
}: {
  userId: string;
  tenantId: string | null;
}) {
  // A layout effect: it runs before any passive effect of the same commit, so an
  // error card that renders on the very first paint still finds who to report as.
  // NOT cleared on unmount (2026-10-27). A crash in the shell itself - the header, the
  // bell, the tab bar, the account panel, a getWorkspace() throw on a refresh - is caught
  // by app/error.tsx, the boundary AROUND the (app) layout, which unmounts this monitor:
  // its cleanup emptied `reporter` before the root card's effect reported, and none of
  // those crashes ever reached the Dev Inbox. The last identity is safe to keep: the
  // client_errors insert policy accepts only user_id = auth.uid() of a tenant member, so
  // a row sent after a sign-out or as another account is refused, never misattributed.
  useLayoutEffect(() => {
    reporter = { userId, tenantId };
  }, [userId, tenantId]);
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      logClientError({
        userId,
        tenantId,
        kind: "error",
        message: e.message || String(e.error ?? "unknown error"),
        stack: (e.error as Error | undefined)?.stack ?? null,
        url: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : null,
      });
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { message?: string; stack?: string } | undefined;
      logClientError({
        userId,
        tenantId,
        kind: "unhandledrejection",
        message: r?.message ? String(r.message) : String(e.reason),
        stack: r?.stack ?? null,
      });
    };
    // lib/csp.ts ships the policy report-only: nothing is blocked, the browser
    // only says what WOULD have been. Those reports are what decides enforcing.
    const onCsp = (v: CspViolation) => {
      logClientError({
        userId,
        tenantId,
        kind: "csp",
        message: cspMessage(v),
        stack: v.x ? String(v.x).slice(0, 200) : null,
        url: v.s ? `${noQuery(v.s)}:${v.l ?? 0}` : location.pathname,
      });
    };
    const w = window as { __cspv?: CspViolation[] };
    for (const v of w.__cspv?.splice(0) ?? []) onCsp(v);
    const onViolation = (e: SecurityPolicyViolationEvent) =>
      onCsp({ d: e.effectiveDirective || e.violatedDirective, b: e.blockedURI, s: e.sourceFile, l: e.lineNumber, x: e.sample });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    document.addEventListener("securitypolicyviolation", onViolation);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      document.removeEventListener("securitypolicyviolation", onViolation);
    };
  }, [userId, tenantId]);
  return null;
}

/**
 * Catch React RENDER crashes (the "white screen") — log them + show a friendly
 * fallback with a reload, instead of an unmounted blank page mid-show.
 */
export class AppErrorBoundary extends Component<
  {
    userId: string;
    tenantId: string | null;
    children: ReactNode;
    /** Desktop only: the HashRouter's current path (the shell's useLocation). Its
     *  escapes set the hash and reload, and Quick Show is offered with them. The web
     *  omits it — its route is the real path. */
    hashRoute?: string;
  },
  { crashed: boolean; saved: boolean | null }
> {
  /** `saved` is null until the capture answers: it is an async write and this is a
   *  sync lifecycle. See the render() note for why the screen waits for it. */
  state: { crashed: boolean; saved: boolean | null } = { crashed: false, saved: null };
  private alive = true;

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentWillUnmount() {
    // The write outlives a fast unmount; setState on a dead boundary would warn
    // and, on a page already showing a crash, warn about the crash handler.
    this.alive = false;
  }

  componentDidCatch(error: Error) {
    void logClientError({
      userId: this.props.userId,
      tenantId: this.props.tenantId,
      kind: "react",
      message: error?.message || "render crash",
      stack: error?.stack ?? null,
    })
      .then((saved) => {
        if (this.alive) this.setState({ saved });
      })
      // logClientError is documented never to throw and catches everything itself
      // — but an unhandled rejection HERE would be raised as a window
      // 'unhandledrejection', which ErrorMonitor listens for and reports, so the
      // crash handler would feed the error reporter that just failed. The one
      // place a swallow is right is the handler of last resort.
      .catch(() => {
        if (this.alive) this.setState({ saved: false });
      });
  }

  render() {
    if (this.state.crashed) {
      // WHAT THIS SCREEN IS ALLOWED TO CLAIM. It used to say "ระบบบันทึกปัญหานี้ไว้
      // ให้แล้ว" unconditionally, while logClientError swallowed every failure of its
      // own — so the one sentence a user reads at the worst moment was never checked
      // against anything. On 2026-09-04 `client_errors` held zero rows for the whole
      // life of the app, and that promise is exactly why nobody could tell a healthy
      // silence from a blind one. Now it says only what is known, and when the
      // capture did NOT land it says so and points at the channel a human reads —
      // which is the whole reason แจ้งปัญหา was made two-way.
      //
      // …and that channel is HERE, on the card. Since the redesign the only other way
      // in is the Feedback tile inside the More sheet / account panel, and Live Mode
      // and the live show-caller have no header and no tab bar to open it from — so on
      // exactly the screens a member is mid-show, the note pointed at a button that
      // did not exist. The tile carries "แจ้งปัญหา" as its own subtitle.
      const failed = this.state.saved === false;
      const { hashRoute } = this.props;
      const hashRouter = hashRoute !== undefined;
      const eventId = immersiveEventId(
        hashRouter ? hashRoute : typeof window === "undefined" ? "" : window.location.pathname
      );
      return (
        <div className="grid min-h-[60vh] place-items-center p-6 text-center">
          <div className="space-y-3">
            <h1 className="text-lg font-semibold">เกิดข้อผิดพลาดบางอย่าง</h1>
            <p className="text-sm text-muted-foreground" data-testid="crash-note">
              {this.state.saved === true
                ? "ระบบบันทึกปัญหานี้ไว้ให้แล้ว — ลองโหลดหน้าใหม่อีกครั้ง"
                : failed
                  ? "บันทึกปัญหาอัตโนมัติไม่สำเร็จ — ถ้าเจอซ้ำ รบกวนกดปุ่ม “แจ้งปัญหา” ด้านล่าง บอกเราหน่อยครับ"
                  : "ลองโหลดหน้าใหม่อีกครั้ง"}
            </p>
            <Button onClick={() => window.location.reload()}>โหลดหน้าใหม่</Button>
            {/* The way out on Live / the show-caller. Before the redesign the header
                above this card (nav, and on the desktop Quick Show) was the way out;
                those screens have none now, reload re-opens the same screen, and a
                crash that comes from the data came straight back — on the .exe,
                quitting mid-show was the only exit. Ordinary pages keep their header. */}
            {eventId && (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button variant="outline" onClick={() => leaveTo(`/events/${eventId}`, hashRouter)}>
                  กลับไปหน้างาน
                </Button>
                {hashRouter && (
                  <Button variant="outline" onClick={() => leaveTo("/my-show", true)}>
                    Quick Show
                  </Button>
                )}
              </div>
            )}
            {failed && (
              <div className="mx-auto w-full max-w-[240px] text-left" data-testid="crash-feedback">
                <FeedbackButton userId={this.props.userId} tenantId={this.props.tenantId} />
              </div>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
