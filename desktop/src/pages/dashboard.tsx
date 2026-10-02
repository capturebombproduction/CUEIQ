// Desktop dashboard — the events list. Mirrors app/(app)/dashboard/page.tsx but
// fetches client-side, then renders the SAME EventsList component the web uses
// (search + next-show banner + offline-ready badges all reused verbatim).
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Music2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EventsList } from "@/components/event/events-list";
import {
  CreateFromTemplateButton,
  type TemplateGroup,
} from "@/components/event/create-from-template-button";
import {
  canCreateAnyEvent,
  canEditGroup,
  canLiveEdit,
  canViewLibrary,
  viewableGroups,
} from "@/lib/permissions";
import { createClient } from "@/lib/supabase/client";
import { isOffline } from "~/data/cache";
import { useWorkspace } from "~/data/workspace-context";
import { loadEventsList, type EventWithGroup } from "~/data/events-list";
import { EVENT_BUNDLE_CACHED_EVENT, cachedCallTimes } from "~/data/event-bundle";
import { warmSongLibrary } from "~/data/song-library";
import { WhatsNew, readerFor } from "@/components/whats-new";
import { PageTitle } from "@/components/page-title";

export function Dashboard() {
  const { ws } = useWorkspace();
  const [events, setEvents] = useState<EventWithGroup[] | null>(null);

  // Per-band scope: label-wide → all bands; a band-tier user → only their own.
  const viewableGroupIds = ws
    ? viewableGroups(ws.perms, ws.groups).map((g) => g.id)
    : [];
  const editableGroupIds = ws
    ? ws.groups.filter((g) => canEditGroup(ws.perms, g.id)).map((g) => g.id)
    : [];
  const scopeKey = viewableGroupIds.join(",");

  useEffect(() => {
    if (!ws?.membership) return;
    let alive = true;
    loadEventsList(ws.membership.tenant_id, viewableGroupIds).then((data) => {
      if (alive) setEvents(data);
    });
    // Warm คลังเพลง's read-cache while there is still a network. That page is the
    // only door to the offline audio-upload queue, and it used to be the only
    // thing that ever filled its own cache — so a fresh install that logged in
    // and drove to the venue found the door shut. The dashboard is where every
    // session starts, so the cache is filled by the time it matters. Silent and
    // best-effort: nothing here is allowed to affect what the dashboard shows.
    if (canViewLibrary(ws.perms)) {
      warmSongLibrary(ws.membership.tenant_id, viewableGroupIds);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.membership?.tenant_id, scopeKey]);

  // Each band's OWN demo-draft template, for "สร้างจากแม่แบบ" — the web dashboard
  // reads them in its server query (app/(app)/dashboard/page.tsx); a dashboard with
  // no network has no use for the button anyway (the clone writes straight to
  // Supabase), so this is best-effort and online-only: a failed or never-answered
  // read leaves the button out, and nothing else on the page waits for it.
  const [templates, setTemplates] = useState<{ id: string; group_id: string }[]>([]);
  const mayCreate = !!ws && canCreateAnyEvent(ws.perms);
  const tenantId = ws?.membership?.tenant_id;
  useEffect(() => {
    // isOffline() like every other loader here: no request goes out into a network
    // the OS already knows is gone (the airplane smoke boots exactly like that).
    if (!tenantId || !mayCreate || isOffline()) return;
    let alive = true;
    (async () => {
      try {
        const { data, error } = await createClient()
          .from("events")
          .select("id, group_id")
          .eq("tenant_id", tenantId)
          .eq("is_template", true);
        if (alive && !error && data) setTemplates(data as { id: string; group_id: string }[]);
      } catch {
        /* best-effort — no button on failure */
      }
    })();
    return () => {
      alive = false;
    };
  }, [tenantId, mayCreate]);

  // The Next Show ticket's "นัด", from the bundles already on this device (the
  // list cache carries no schedules). undefined = the ticket's own show is not cached
  // → unknown, and the cell is left out.
  //
  // The cache fills while this page stays up: "เตรียมทุกงาน" warms the bundles one by
  // one, and the ticket's show may be among the last — so a bundle landing (or the
  // window coming back, or the network returning: the same triggers EventsList's
  // readiness badges re-read on) bumps `cacheTick` and the lookup runs again.
  const [cacheTick, setCacheTick] = useState(0);
  useEffect(() => {
    const bump = () => setCacheTick((n) => n + 1);
    const onVisible = () => {
      if (document.visibilityState === "visible") bump();
    };
    window.addEventListener(EVENT_BUNDLE_CACHED_EVENT, bump);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", bump);
    return () => {
      window.removeEventListener(EVENT_BUNDLE_CACHED_EVENT, bump);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", bump);
    };
  }, []);
  const callTimes = useMemo(
    () => (events ? cachedCallTimes(events) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cacheTick re-reads the cache
    [events, cacheTick]
  );

  if (!ws?.membership || !ws.tenant) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          บัญชีนี้ยังไม่ได้ผูกกับ Label — เข้าใช้งานผ่านเว็บเพื่อรับสิทธิ์ก่อน
        </CardContent>
      </Card>
    );
  }

  const canCreate = canCreateAnyEvent(ws.perms);
  // "สร้างจากแม่แบบ": each band clones ITS OWN template, so offer only the user's
  // editable bands that have one (same rule as the web dashboard).
  const templateByGroup = new Map(templates.map((t) => [t.group_id, t.id]));
  const templateGroups: TemplateGroup[] = ws.groups
    .filter((g) => canEditGroup(ws.perms, g.id) && templateByGroup.has(g.id))
    .map((g) => ({ id: g.id, name: g.name, templateId: templateByGroup.get(g.id)! }));
  const showTemplate = canCreate && templateGroups.length > 0;
  // Same title meta as the web dashboard: who, today, and whose shows these are.
  const viewable = viewableGroups(ws.perms, ws.groups);
  const bandLabel = viewable.length === 1 ? viewable[0].name : ws.tenant.name;
  const todayTh = new Intl.DateTimeFormat("th-TH", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Asia/Bangkok",
  }).format(new Date());
  // Same card as the web dashboard (components/whats-new.tsx), under the ticket — told
  // WHO is reading, from the account's own rules, so an admin is not pointed at the
  // banner's "ซ้อมตามเซ็ต" button (their second button is Live Mode) nor label staff at
  // the Library / practice room they do not have. `canEdit` is this page's own answer
  // (the bands this account may edit), as on the web dashboard.
  const whatsNew = <WhatsNew reader={readerFor(ws.perms, editableGroupIds.length > 0)} />;

  return (
    // data-cueiq-events: how many shows this account can actually see right now.
    // The packaged app's offline self-test asserts it EQUALS the number it seeded
    // into the cache — "> 0" would pass on a cache-key mismatch, and the key
    // (~/data/events-list.ts: `events:<tenant>:<sorted group ids>`) is derived from
    // permissions, so a scope change silently empties the dashboard offline while
    // everything else on screen still looks correct. -1 while the read is in flight,
    // so "still loading" can never be mistaken for "no shows".
    <div className="space-y-3" data-cueiq-events={events === null ? -1 : events.length}>
      <PageTitle
        title="Events"
        right={
          <div className="max-w-[12.5rem] pb-[1px] text-right text-[12.5px] leading-snug text-muted-foreground">
            {ws.user?.name && <span className="block truncate">สวัสดี {ws.user.name}</span>}
            <span className="block truncate">
              {todayTh} · <span className="font-medium text-foreground">{bandLabel}</span>
            </span>
          </div>
        }
      />
      {canCreate && (
        <div className="flex flex-wrap gap-2">
          {showTemplate && <CreateFromTemplateButton groups={templateGroups} />}
          <Button asChild variant="secondary">
            <Link to="/events/new">
              <Plus aria-hidden />
              <span className="en">New Event</span>
            </Link>
          </Button>
        </div>
      )}

      {events === null ? (
        <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลดงาน…</p>
      ) : events.length === 0 ? (
        <>
          {whatsNew}
          <Card>
            <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <Music2 className="h-10 w-10 text-muted-foreground" />
              <p className="text-muted-foreground">No events yet</p>
              {canCreate && (
                <Button asChild variant="secondary">
                  <Link to="/events/new">
                    <Plus className="h-4 w-4" /> Create your first event
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>
        </>
      ) : (
        // Call times come from the cached bundles (cachedCallTimes): this list is an
        // offline cache without schedules, and with no bundle on the device the call
        // time is unknown, so the ticket leaves "นัด" out instead of printing "—".
        <EventsList
          events={events}
          editableGroupIds={editableGroupIds}
          callTimes={callTimes}
          canRunLive={canLiveEdit(ws.perms)}
          canPractice={ws.perms.tenantRole !== "label_staff"}
          belowHero={whatsNew}
        />
      )}
    </div>
  );
}
