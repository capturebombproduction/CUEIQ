import { redirect } from "next/navigation";
import { getWorkspace } from "@/lib/queries";
import { SiteHeader } from "@/components/site-header";
import { ErrorMonitor, AppErrorBoundary } from "@/components/error-monitor";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { FeedbackUnreadProvider } from "@/components/feedback-button";
import { PushNudge } from "@/components/notifications/push-nudge";
import { ChromeGate } from "@/components/chrome-gate";
import { AppMain } from "@/components/app-main";
import { TabBar } from "@/components/tab-bar";
import { FRAME_LIGHT_AIM, StageLight } from "@/components/stage-light";
import { cn } from "@/lib/utils";
import { AccountPanel, AccountPanelProvider } from "@/components/account-panel";
import { accountLine } from "@/lib/role-label";
import { canEditAnyGroup } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ws = await getWorkspace();
  if (!ws.user) redirect("/login");

  const tenantId = ws.membership?.tenant_id ?? null;
  // ws.groups THROWS when its read failed (lib/queries.ts, READ 4) — on purpose, so
  // a page cannot mistake a failed read for "no bands". Read here, that throw would
  // take the whole shell down to app/error.tsx instead of the page's own card. The
  // band name on the account panel is decoration, so a failed read just leaves it
  // off; the page reads groups itself and still reports the failure honestly.
  let groups: { id: string; name: string }[] = [];
  try {
    groups = ws.groups;
  } catch {
    /* see above */
  }

  return (
    // One unread-answer count and one panel state for the whole shell: the More
    // tab, the header avatar and the Feedback tile all read them.
    <FeedbackUnreadProvider userId={ws.user.id}>
      <AccountPanelProvider>
        {/* relative isolate: the page light (v3 Stage Wash) is this wrapper's first
            child and paints just above its background, with header / main / bars
            above it. Nothing here may carry transform, filter or contain — any of
            them would turn that layer's `fixed` into "absolute to this box". lg: the
            header row is 56px, there is no tab bar to leave room for, and the light
            aims at the left-aligned page title (FRAME_LIGHT_AIM). */}
        <div
          className={cn(
            "relative isolate min-h-screen bg-background lg:[--header-h:56px] lg:[--tabbar-h:0px]",
            FRAME_LIGHT_AIM
          )}
        >
          {/* Gated: Live Mode and the live show-caller hang their own, inside the
              root .zone-over sits on and aimed at the NOW column — one per document. */}
          <ChromeGate>
            <StageLight />
          </ChromeGate>
          {/* auto-capture client errors for the whole authenticated app */}
          <ErrorMonitor userId={ws.user.id} tenantId={tenantId} />
          {/* Live Mode and the live show-caller are immersive: no header there. */}
          <ChromeGate>
            <SiteHeader
              name={ws.user.name}
              perms={ws.perms}
              userId={ws.user.id}
              tenantId={tenantId}
            />
          </ChromeGate>
          {/* overflow-x-clip, never overflow-hidden: hidden would make <main> a
              scroll container and break every sticky element inside it. The bottom
              padding keeps the last row clear of the tab bar. On the immersive
              screens AppMain drops the container and all of this padding — they
              are edge to edge and own their gutter (components/app-main.tsx). */}
          <AppMain className="container relative z-[1] overflow-x-clip pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+24px)] pt-5 lg:py-8">
            <AppErrorBoundary userId={ws.user.id} tenantId={tenantId}>
              <ConfirmProvider>{children}</ConfirmProvider>
            </AppErrorBoundary>
          </AppMain>
          {/* Below lg. Hides itself on the immersive screens (and zeroes --tabbar-h). */}
          <TabBar perms={ws.perms} />
          {/* The More sheet: account tools, What's New and Feedback. There is NO
              floating แจ้งปัญหา button any more — the Feedback tile in here is the
              way in (layout.test.tsx pins its absence). */}
          <AccountPanel
            name={ws.user.name}
            line={accountLine({
              role: ws.membership?.role ?? null,
              perms: ws.perms,
              groups,
              tenantName: ws.tenant?.name,
            })}
            perms={ws.perms}
            userId={ws.user.id}
            tenantId={tenantId}
            canEdit={canEditAnyGroup(ws.perms)}
          />
          {/* Asks ONCE, per device, and never over a running show — the only way to
              turn push on used to be a button inside the bell dropdown, and eighteen
              of nineteen accounts never found it. */}
          <ChromeGate>
            <PushNudge userId={ws.user.id} tenantId={tenantId} />
          </ChromeGate>
        </div>
      </AccountPanelProvider>
    </FeedbackUnreadProvider>
  );
}
