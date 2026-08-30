"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Check, ClipboardList, Loader2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/refresh-button";
import { ShareButton } from "@/components/event/share-button";
import { EventSummary } from "@/components/event/event-summary";
import { type RunSeqLive } from "@/components/event/event-live-caller";

// The per-tab editors are heavy (SetlistBuilder alone is ~700 lines) and aren't
// needed until their tab is opened — the page lands on Summary. Code-split them
// so opening an event ships only the Summary + shell JS; each editor's chunk is
// fetched the first time its tab is shown. ssr:false is fine here (this is a
// Client Component, and the editors are client-only interactive surfaces).
const editorLoading = () => (
  <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
    <Loader2 className="h-4 w-4 animate-spin" /> กำลังโหลด…
  </div>
);
const SetlistBuilder = dynamic(
  () => import("@/components/event/setlist-builder").then((m) => m.SetlistBuilder),
  { ssr: false, loading: editorLoading }
);
const ScheduleEditor = dynamic(
  () => import("@/components/event/schedule-editor").then((m) => m.ScheduleEditor),
  { ssr: false, loading: editorLoading }
);
const MicMapEditor = dynamic(
  () => import("@/components/event/mic-map-editor").then((m) => m.MicMapEditor),
  { ssr: false, loading: editorLoading }
);
const LineupEditor = dynamic(
  () => import("@/components/event/lineup-editor").then((m) => m.LineupEditor),
  { ssr: false, loading: editorLoading }
);
import { createClient } from "@/lib/supabase/client";
import { notify } from "@/lib/notify-client";
import { type CompletenessResult } from "@/lib/completeness";
import { wroteNothing } from "@/lib/write-guard";
import {
  EVENT_TYPES,
  type EventRow,
  type EventType,
  type Group,
  type GroupStatus,
  type Member,
  type MicAssignment,
  type ScheduleItem,
  type SetlistItem,
  type Song,
} from "@/lib/types";

export function EventWorkspace({
  event,
  eventId,
  tenantId,
  editable,
  completeness,
  eventType,
  showStartTime,
  hardOutTime,
  schedule,
  setlist,
  micMap,
  members,
  songs,
  lineup,
  runSeq = [],
}: {
  event: EventRow & { group: Group | null };
  eventId: string;
  tenantId: string;
  editable: boolean;
  completeness: CompletenessResult;
  eventType: EventType;
  showStartTime: string | null;
  hardOutTime: string | null;
  schedule: ScheduleItem[];
  setlist: SetlistItem[];
  micMap: MicAssignment[];
  members: Member[];
  songs: Song[];
  lineup: string[];
  /** This festival's running order — drives the read-only live status card. */
  runSeq?: RunSeqLive[];
}) {
  const modules = EVENT_TYPES[eventType]?.modules ?? EVENT_TYPES.idol.modules;
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  // Auto-transition the event between draft ↔ pending_review based on
  // completeness. Only editors (admin / the band's Ar) can write status (RLS),
  // and only the draft/pending_review window is auto-managed — approved/rejected
  // are left to the explicit approval flow. A ref guards against double-firing
  // before router.refresh() lands the new status (re-armed below once it does).
  const status = event.status as GroupStatus;
  const syncing = useRef(false);
  // Re-arm the guard when the status prop actually changes: the write's round
  // trip has landed (via router.refresh) — or someone else moved the event — so
  // later completeness flips can auto-sync again. When the refresh brings back
  // the SAME status (e.g. a desktop reload served from the offline cache),
  // staying latched is correct — un-latching against a stale prop would just
  // re-issue the same write in a loop.
  useEffect(() => {
    syncing.current = false;
  }, [status]);

  // Every editor in here commits on BLUR. That is fine on a laptop, where leaving
  // the page always blurs the field first — but a phone or tablet doesn't work
  // that way: switching apps, locking the screen or a swipe-away leaves the field
  // focused and the page frozen, so the last thing typed (a stage time, a song
  // title, a mic number) was never sent anywhere. Blurring on the way out gives
  // each editor its normal save path one last chance, with no change to how any of
  // them work. Best effort by nature — if the OS freezes us first, the write goes
  // with it — but it costs nothing and covers the ordinary "I switched to LINE for
  // a second" case, which is most of them.
  useEffect(() => {
    const commitFocused = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.blur();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") commitFocused();
    };
    window.addEventListener("pagehide", commitFocused);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", commitFocused);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);
  useEffect(() => {
    if (!editable || event.is_template || syncing.current) return;
    let next: GroupStatus | null = null;
    // "In Progress" is offered in the status dropdown but nothing ever moved an
    // event out of it: only draft auto-advanced, so an event parked there stayed
    // there however complete it got, and never reached an approver. (One real
    // production event has been sitting in it.) It means the same thing draft does
    // — being worked on — so it advances the same way, and self-heals on open.
    if ((status === "draft" || status === "in_progress") && completeness.complete)
      next = "pending_review";
    else if (status === "pending_review" && !completeness.complete) next = "draft";
    if (!next) return;
    syncing.current = true;
    const target = next;
    (async () => {
      const { data, error } = await createClient()
        .from("events")
        .update({ status: target })
        .eq("id", eventId)
        .select("id");
      // Same class as lib/write-guard.ts: no error and no row means the request
      // reached the server and changed nothing (sent as anon after a failed token
      // refresh, or blocked by 0037's guard). Announcing "ส่งขออนุมัติให้อัตโนมัติ"
      // for that is how a show sits in draft while the band believes an approver
      // has it. Un-latch so a later render retries instead.
      if (error || wroteNothing(data)) {
        syncing.current = false; // RLS or transient — let a later render retry
        return;
      }
      toast.success(
        target === "pending_review"
          ? "ข้อมูลครบแล้ว — ส่งขออนุมัติให้อัตโนมัติ 🟠"
          : "ข้อมูลไม่ครบ — กลับเป็นแบบร่าง (Draft)"
      );
      // complete → pending_review: notify the approvers it's waiting
      if (target === "pending_review") notify("event_submitted", { eventId });
      router.refresh();
    })();
  }, [editable, status, completeness.complete, eventId, router, event.is_template]);
  // remember the tab in the URL so a reload returns here (not back to Summary).
  // Web: the route is a real path, so the hash is a free slot (#setlist).
  // Desktop (HashRouter): the WHOLE route lives in the hash (#/events/<id>) —
  // writing #setlist there would destroy the route, so the tab rides in the
  // hash-route's query string (#/events/<id>?tab=setlist) instead.
  // Read it AFTER mount to avoid a hydration mismatch.
  const [view, setView] = useState<string>("summary");
  useEffect(() => {
    const hash = window.location.hash;
    const h = hash.startsWith("#/")
      ? new URLSearchParams(hash.split("?")[1] ?? "").get("tab") ?? ""
      : hash.replace("#", "");
    if (["summary", "setlist", "schedule", "mic", "lineup"].includes(h)) setView(h);
  }, []);

  // Tabs opened at least once. Radix unmounts an inactive tab's content, which
  // threw the editor's local state away: coming back re-seeded it from the
  // PAGE-LOAD props, so auto-saved edits vanished from the UI, a stale onBlur
  // wrote the OLD value back over the DB, and an insert took sort_order from the
  // stale list (duplicate sort_order → Live Mode plays a song twice). Once
  // opened, an editor stays MOUNTED (just hidden) so its state survives a tab
  // round-trip. Tracked per tab — not forceMount on all — so each editor's chunk
  // is still fetched lazily the first time its tab is shown.
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setOpened((prev) => (prev.has(view) ? prev : new Set(prev).add(view)));
  }, [view]);
  // Radix's forceMount only takes `true`; undefined = its default (unmount).
  const keepMounted = (tab: string) => (opened.has(tab) ? true : undefined);

  // Staying mounted forever, though, removes the ONLY re-seed path: an editor
  // reads these props at MOUNT, so a hidden panel drifts behind the DB as soon as
  // someone ELSE edits the event — Summary refreshes and shows their new setlist
  // row while the hidden Setlist panel still holds the old list, and back on that
  // tab "+ เพลง" takes max(sort_order)+1 from the stale list (colliding with their
  // row → Live Mode's order ≠ the printed run sheet) and a blur on a row they
  // renamed writes the old title back over theirs.
  // So re-key (= remount → re-seed) a panel when the server data it seeded from
  // ACTUALLY changed, and only while it is HIDDEN: a hidden panel holds no focus
  // and every edit auto-saves, so there is nothing of the user's to lose there.
  // The ACTIVE tab is never re-keyed, and an unchanged refresh never re-keys —
  // so a refresh that raced a just-saved write can't drop the newer local state,
  // and SetlistBuilder's live channel isn't torn down on every render.
  const seeds = useMemo(
    () => ({
      setlist: JSON.stringify(setlist),
      schedule: JSON.stringify(schedule),
      mic: JSON.stringify(micMap),
      // lineup becomes a Set in the editor — order carries no meaning and the
      // query doesn't pin one, so a reshuffle of the same ids isn't a change.
      lineup: JSON.stringify([...lineup].sort()),
    }),
    [setlist, schedule, micMap, lineup]
  );
  // What each panel is (or, if not mounted yet, will be) seeded with — a ref: it
  // only ever feeds the comparison below, it must not itself trigger a render.
  const seededWith = useRef<Record<string, string>>({});
  const [seedRev, setSeedRev] = useState<Record<string, number>>({});
  useEffect(() => {
    const stale: string[] = [];
    for (const [tab, fingerprint] of Object.entries(seeds)) {
      if (tab === view) continue; // active tab: the user's state wins, never remount
      const before = seededWith.current[tab];
      seededWith.current[tab] = fingerprint;
      // An unopened tab isn't mounted — it seeds from whatever props are current
      // when it first opens, so tracking the fingerprint is all it needs.
      if (opened.has(tab) && before !== undefined && before !== fingerprint) {
        stale.push(tab);
      }
    }
    if (!stale.length) return;
    setSeedRev((prev) => {
      const next = { ...prev };
      for (const tab of stale) next[tab] = (prev[tab] ?? 0) + 1;
      return next;
    });
  }, [seeds, view, opened]);
  const seedKey = (tab: string) => seedRev[tab] ?? 0;

  function changeView(v: string) {
    // Entering Summary (which renders the export JPG / printable run-sheet) from
    // an editor tab: pull fresh server data first, so the summary and its image
    // reflect edits that auto-saved in the editor but otherwise live only in that
    // editor's local state until a refresh — the same stale-props class as the
    // overview photo-time export. Online only (offline we keep what we have
    // rather than hang on a refetch; on desktop the shim's refresh() re-loads
    // the event bundle in place).
    if (
      v === "summary" &&
      view !== "summary" &&
      (typeof navigator === "undefined" || navigator.onLine)
    ) {
      router.refresh();
    }
    setView(v);
    if (typeof window !== "undefined") {
      const hash = window.location.hash;
      if (hash.startsWith("#/")) {
        // HashRouter (desktop): keep the route, swap only the tab param — and
        // preserve history.state, where react-router keeps its history index.
        const path = hash.slice(1).split("?")[0];
        window.history.replaceState(window.history.state, "", `#${path}?tab=${v}`);
      } else {
        window.history.replaceState(null, "", `#${v}`);
      }
    }
  }

  // Reassurance "save" — data already auto-saves on edit; this just pulls fresh
  // server data WITHOUT leaving the current tab and confirms with a toast.
  function confirmSaved() {
    setSaving(true);
    router.refresh();
    toast.success("บันทึกเรียบร้อยแล้ว");
    setTimeout(() => setSaving(false), 800);
  }

  return (
    <div className="w-full space-y-4">
      {/* An APPROVED show that has since lost something required. The auto-effect
          above only walks draft/in_progress → pending_review → draft, so once a
          show is approved nothing re-checks it — and editing is deliberately never
          gated on approval ("วงควรแก้เมื่อไหร่ก็ได้"). So an Ar can delete an STB
          row to re-enter it, get interrupted, and the event keeps its green
          Approved badge with a hole in it. Nobody inside the app notices; the crew
          at the venue does. Deliberately says so rather than un-approving on its
          own: reversing a staff decision without asking is its own kind of wrong. */}
      {!completeness.complete &&
        !event.is_template &&
        (status === "approved" || status === "overdue") && (
          <div className="no-print rounded-lg border border-destructive/50 bg-destructive/10 p-3">
            <div className="flex items-center gap-2 font-semibold text-destructive">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              งานนี้อนุมัติไปแล้ว แต่ตอนนี้ข้อมูลไม่ครบ ({completeness.missing.length})
            </div>
            <ul className="ml-7 mt-1.5 list-disc space-y-0.5 text-sm text-muted-foreground">
              {completeness.missing.map((m) => (
                <li key={m.key}>{m.label}</li>
              ))}
            </ul>
            <p className="ml-7 mt-1.5 text-sm text-muted-foreground">
              เติมให้ครบก่อนวันงาน หรือแจ้งทีมค่ายให้ตรวจอีกครั้ง
            </p>
          </div>
        )}

      {/* Big Summary button (default view) + refresh */}
      <div className="no-print flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="lg"
          variant={view === "summary" ? "default" : "outline"}
          onClick={() => changeView("summary")}
          className="font-semibold"
        >
          <ClipboardList className="h-5 w-5" /> สรุปงาน (Summary)
        </Button>
        <RefreshButton />
        {editable && (
          <ShareButton
            eventId={eventId}
            initialToken={event.share_token}
            initialExpiresAt={event.share_expires_at}
          />
        )}
      </div>

      {/* WHY the page is read-only, said once, where the reader is.
          Reported through the in-app feedback channel as a BUG ("แก้ไขตารางเวลาไม่ได้",
          2026-06-27, from a Label Staff account) — and it is not one: editing a
          band's call sheet belongs to that band's Ar and to admins, while
          label-wide staff review and approve. The rule stands (พี่'s call
          2026-08-16); what was missing is that the app never said so. Disabled
          fields with no explanation read as a broken page, and the person who
          hits them has no way to tell which it is. */}
      {!editable && (
        <div
          className="no-print rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100"
          data-testid="read-only-notice"
        >
          <span className="font-medium">ดูอย่างเดียว</span> — งานของวงแก้ได้โดย{" "}
          <span className="font-medium">Ar ของวงนั้น</span> หรือ{" "}
          <span className="font-medium">แอดมิน</span> เท่านั้น
          {event.is_template ? " (และแม่แบบแก้ได้จากหน้าแม่แบบ)" : ""} — ถ้าต้องแก้จริง ๆ
          ทักคนใดคนหนึ่งได้เลย
        </div>
      )}

      <Tabs value={view} onValueChange={changeView} className="w-full">
        <TabsList className="no-print flex h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="setlist">Setlist + Run Time</TabsTrigger>
          <TabsTrigger value="schedule">นัดหมาย</TabsTrigger>
          {modules.micMap && <TabsTrigger value="mic">Mic Map</TabsTrigger>}
          <TabsTrigger value="lineup">รายชื่อวันนี้</TabsTrigger>
        </TabsList>

        <TabsContent value="summary">
          <EventSummary
            event={event}
            schedule={schedule}
            setlist={setlist}
            members={members}
            showMic={modules.micMap}
            onNavigate={changeView}
            lineup={lineup}
            completeness={completeness}
            editable={editable}
            tenantId={tenantId}
            runSeq={runSeq}
          />
        </TabsContent>

        {/* forceMount keeps an already-opened editor alive across tab switches;
            Radix only sets `hidden` on content it would have unmounted, so a
            force-mounted panel has to be hidden here. */}
        <TabsContent
          value="setlist"
          forceMount={keepMounted("setlist")}
          hidden={view !== "setlist"}
        >
          <SetlistBuilder
            key={seedKey("setlist")}
            eventId={eventId}
            tenantId={tenantId}
            editable={editable}
            initialItems={setlist}
            showStartTime={showStartTime}
            hardOutTime={hardOutTime}
            members={members}
            songs={songs}
            eventName={event.name}
          />
        </TabsContent>

        <TabsContent
          value="schedule"
          forceMount={keepMounted("schedule")}
          hidden={view !== "schedule"}
        >
          <ScheduleEditor
            key={seedKey("schedule")}
            eventId={eventId}
            tenantId={tenantId}
            editable={editable}
            initialItems={schedule}
            eventName={event.name}
          />
        </TabsContent>

        <TabsContent
          value="lineup"
          forceMount={keepMounted("lineup")}
          hidden={view !== "lineup"}
        >
          <LineupEditor
            key={seedKey("lineup")}
            eventId={eventId}
            tenantId={tenantId}
            editable={editable}
            members={members}
            initialLineup={lineup}
            eventName={event.name}
          />
        </TabsContent>

        {modules.micMap && (
          <TabsContent
            value="mic"
            forceMount={keepMounted("mic")}
            hidden={view !== "mic"}
          >
            <MicMapEditor
              key={seedKey("mic")}
              eventId={eventId}
              tenantId={tenantId}
              editable={editable}
              initialMics={micMap}
              members={members}
              setlist={setlist}
              eventName={event.name}
            />
          </TabsContent>
        )}
      </Tabs>

      {/* Bottom action bar — the "save" button STAYS on the current tab and just
          confirms with a toast (data already auto-saves). No page bounce. */}
      {view !== "summary" && (
        <div className="no-print mt-2 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3">
          <Button
            type="button"
            variant="default"
            onClick={confirmSaved}
            disabled={saving}
            className="font-semibold"
          >
            <Check className="h-4 w-4" /> บันทึก / อัปเดต
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => changeView("summary")}
          >
            <ClipboardList className="h-4 w-4" /> ดูสรุปงาน
          </Button>
        </div>
      )}
    </div>
  );
}
