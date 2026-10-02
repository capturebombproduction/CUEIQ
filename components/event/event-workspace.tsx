"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Check, ClipboardList, Eye, Loader2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { EventSummary } from "@/components/event/event-summary";
import { useLeaveGuard } from "@/components/event/use-leave-guard";
import { commitFocusedField, unsavedWork } from "@/lib/dirty-guard";
import { useHoldBottomSlot } from "@/lib/bottom-slot";
import { bkkTodayKey } from "@/lib/time";
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

/** The Summary segment's own classes — a TabsTrigger's, which it copies because it
 *  cannot be one (see the note at the TabsList). The seg primitive draws the rest. */
const SEG_ITEM_CLS =
  "transition-colors duration-2 ease-out data-[state=inactive]:hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

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
  canRunLive = true,
  liveInHero = false,
  summaryFooter,
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
  /** canLiveEdit — admin only. Decides whether Live Mode is the summary's
   *  primary button or a secondary one (see EventSummary). */
  canRunLive?: boolean;
  /** The page's hero (EventHero) already carries Live Mode, so the Summary's own
   *  action bar leaves it out rather than offer it twice on one screen. */
  liveInHero?: boolean;
  /** What belongs under the run sheet on the Summary view only — the approvers'
   *  copyright triage (spec G.3; it sat between the hero and these tabs, one
   *  62 px row per song, and pushed the tabs off a phone's first screen).
   *  Kept MOUNTED and hidden on the other views, unlike the Summary itself: the
   *  panel seeds its rows from page-load props, so a remount on every return to
   *  Summary would show a song just approved as waiting again. */
  summaryFooter?: ReactNode;
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
    const onHide = () => {
      if (document.visibilityState === "hidden") commitFocusedField();
    };
    window.addEventListener("pagehide", commitFocusedField);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", commitFocusedField);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  // …and the other half of the same request (2026-08-13): warn on the way OUT when
  // something did not save. Only where there is something to lose — a read-only
  // viewer and a template have no autosaving editors mounted.
  useLeaveGuard(editable && !event.is_template);
  useEffect(() => {
    if (!editable || event.is_template || syncing.current) return;
    let next: GroupStatus | null = null;
    // "In Progress" is offered in the status dropdown but nothing ever moved an
    // event out of it: only draft auto-advanced, so an event parked there stayed
    // there however complete it got, and never reached an approver. (One real
    // production event has been sitting in it.) It means the same thing draft does
    // — being worked on — so it advances the same way, and self-heals on open.
    // …but never for a show that has already happened. When members' own mic
    // numbers started counting (2026-09-28) every one of Seishin Kakumei's past
    // drafts became "complete" at once, and this effect runs whenever an editor
    // merely OPENS a show — so browsing last month would have sent twenty
    // approval requests for shows nobody can approve any more, and pinged the
    // approvers for each. An approval is a question about a show still to come.
    const alreadyHappened = !!event.event_date && event.event_date < bkkTodayKey();
    if (
      (status === "draft" || status === "in_progress") &&
      completeness.complete &&
      !alreadyHappened
    )
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
  }, [
    editable,
    status,
    completeness.complete,
    eventId,
    router,
    event.is_template,
    event.event_date,
  ]);
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
  async function confirmSaved() {
    setSaving(true);
    // This button used to assert success unconditionally. Now that the app knows
    // when a write did not land, saying "บันทึกเรียบร้อยแล้ว" over a failed one
    // would be the same false receipt lib/write-guard.ts exists to stop — and the
    // person pressing it is asking precisely because they are unsure.
    //
    // ⚠️ BUT IT MUST WAIT FIRST. Pressing this button blurs the field you were just
    // in, which STARTS a save; reading the counters on the next line would find
    // that write in flight and call a perfectly healthy autosave "ยังไม่ได้บันทึก"
    // — on the single most common path this button has. Only `failed` is an answer
    // at this instant, so give the writes a moment to land and then judge on that.
    commitFocusedField();
    router.refresh();
    const deadline = Date.now() + 2500;
    while (unsavedWork().pending > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const { pending, failed } = unsavedWork();
    if (failed > 0) {
      toast.error("ยังบันทึกไม่ครบ", {
        description: "มีการแก้ไขที่ยังไม่ได้บันทึก — ลองแก้ช่องนั้นอีกครั้งแล้วคลิกออกจากช่อง",
      });
    } else if (pending > 0) {
      // Still on the wire after 2.5s — say what is true rather than guessing.
      toast.info("ยังบันทึกอยู่", { description: "เน็ตช้า — รอสักครู่แล้วดูป้าย “บันทึกแล้ว”" });
    } else {
      toast.success("บันทึกเรียบร้อยแล้ว");
    }
    setSaving(false);
  }

  return (
    <div className="w-full space-y-3">
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
          <div className="no-print slab p-3 shadow-[inset_3px_0_0_hsl(var(--destructive)),inset_0_0_0_1px_hsl(var(--border))]">
            <div className="flex items-center gap-2 font-semibold text-foreground">
              <AlertTriangle aria-hidden className="h-5 w-5 shrink-0 text-destructive" />
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

      {/* (The big "สรุปงาน" button, Refresh and Share that sat here moved: Summary
          is the first segment below, Refresh and Share are in the hero's ⋯.) */}

      {/* WHY the page is read-only, said once, where the reader is.
          Reported through the in-app feedback channel as a BUG ("แก้ไขตารางเวลาไม่ได้",
          2026-06-27, from a Label Staff account) — and it is not one: editing a
          band's call sheet belongs to that band's Ar and to admins, while
          label-wide staff review and approve. The rule stands (พี่'s call
          2026-08-16); what was missing is that the app never said so. Disabled
          fields with no explanation read as a broken page, and the person who
          hits them has no way to tell which it is. */}
      {/* Not on the summary: nothing there is editable by anyone, and it is the
          page every member opens a show to — the box was the first thing they
          read, every time, about a limit that was not in their way. */}
      {/* ONE line on a phone (2026-10-01, §J): at two lines it pushed a member's
          first setlist row past the fold. Who can edit is the message that matters;
          the "ทักได้เลย" after it was dropped for the room. */}
      {!editable && view !== "summary" && (
        <div
          className="no-print flex items-start gap-2 rounded-[2px] bg-muted px-3 py-1.5 text-[12.5px] leading-snug text-muted-foreground shadow-edge"
          data-testid="read-only-notice"
        >
          <Eye aria-hidden className="mt-px h-4 w-4 flex-none" />
          <span>
            <span className="font-semibold text-foreground">ดูอย่างเดียว</span> — แก้ได้โดย{" "}
            <span className="font-semibold text-foreground">Ar ของวง</span> หรือ{" "}
            <span className="font-semibold text-foreground">แอดมิน</span>
            {event.is_template ? " (แม่แบบแก้ที่หน้าแม่แบบ)" : ""}
          </span>
        </div>
      )}

      <Tabs value={view} onValueChange={changeView} className="w-full">
        {/* ⚠️ THESE HAVE TO LOOK LIKE BUTTONS. Reported from a phone on 2026-09-06:
            "แก้เซ็ตลิสต์ในงานไม่ได้ กดตรงไหน" — not broken, unfindable. The default
            view, Summary, used to sit OUTSIDE this row as a big button, so on arrival
            nothing in the row was selected and it read as a line of headings.
            Summary is now the row's first segment (spec G.3), so one segment is
            always the solid foreground block and the row always reads as a control.

            Sticky under the header, on an OPAQUE bar (glass is for the header and
            tab bar only), so the way between the editors is always one tap away.
            Offline the header is taller by its offline strip, whose measured height
            components/offline-banner.tsx publishes as --offline-strip-h.
            `lit-bar` (app/stage.css) fills it with the page colour AND the page
            light, so stuck in the hot core it no longer cuts a flat unlit band
            through it; it needs the sticky z-30 (a stacking context) and no bg. */}
        <div className="lit-bar no-print sticky top-[calc(var(--header-h)+var(--offline-strip-h,0px)+env(safe-area-inset-top))] z-30 -mx-1 px-1 py-2">
          <TabsList className="en">
            {/* NOT a TabsTrigger. A Radix trigger switches on MOUSEDOWN, before the
                field being edited loses focus and starts its autosave; entering
                Summary refreshes the page data for the run sheet and its JPG
                (changeView), so that refresh would read the database a moment
                before the last edit lands, and the sheet would miss it. A plain
                click fires after the blur, as the old Summary button did. */}
            <button
              type="button"
              role="tab"
              aria-selected={view === "summary"}
              data-state={view === "summary" ? "active" : "inactive"}
              onClick={() => changeView("summary")}
              className={SEG_ITEM_CLS}
            >
              Summary
            </button>
            <TabsTrigger value="setlist">Setlist</TabsTrigger>
            <TabsTrigger value="schedule">Schedule</TabsTrigger>
            {modules.micMap && <TabsTrigger value="mic">Mics</TabsTrigger>}
            <TabsTrigger value="lineup">Lineup</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="summary" className="mt-2">
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
            canRunLive={canRunLive}
            showLive={!liveInHero}
            tenantId={tenantId}
            runSeq={runSeq}
          />
        </TabsContent>
        {summaryFooter && (
          <div hidden={view !== "summary"} className="mt-3">
            {summaryFooter}
          </div>
        )}

        {/* forceMount keeps an already-opened editor alive across tab switches;
            Radix only sets `hidden` on content it would have unmounted, so a
            force-mounted panel has to be hidden here. */}
        <TabsContent
          value="setlist"
          className="mt-1"
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
          className="mt-1"
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
          className="mt-1"
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
            className="mt-1"
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
              lineup={lineup}
              setlist={setlist}
              eventName={event.name}
            />
          </TabsContent>
        )}
      </Tabs>

      {/* Bottom action bar — the "save" button STAYS on the current tab and just
          confirms with a toast (data already auto-saves). No page bounce. A solid
          slab floating just above the tab bar (spec §G.4), primary at the right.
          Only for someone who can edit: a read-only member has nothing to save, and
          on first paint the bar sat over their first setlist row (§J). The way back
          to the run sheet is the Summary segment, always in the sticky row above. */}
      {editable && view !== "summary" && (
        <SaveBar
          saving={saving}
          onSummary={() => changeView("summary")}
          onSave={confirmSaved}
        />
      )}
    </div>
  );
}

/** The sticky save bar. Its own component only so it can HOLD the bottom slot
 *  (lib/bottom-slot.ts) for exactly as long as it is on screen: it floats on the
 *  same pixels as the push nudge, and the nudge (z-50, outside <main>) used to
 *  cover ดูสรุปงาน / บันทึก on every width. The nudge now waits — hidden, not
 *  dismissed — and shows on the next page that has no bar.
 *
 *  Kept BELOW the workspace on purpose: lib/stage-wash.test.ts reads this file
 *  for the FIRST sticky className and expects it to be the tab strip's. */
function SaveBar({
  saving,
  onSummary,
  onSave,
}: {
  saving: boolean;
  onSummary: () => void;
  onSave: () => void;
}) {
  useHoldBottomSlot();
  return (
    <div className="no-print sticky bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+8px)] z-30 mt-2 flex items-center justify-end gap-2 rounded-[3px] bg-card p-2 shadow-float lg:bottom-4">
      <Button type="button" variant="secondary" onClick={onSummary}>
        <ClipboardList aria-hidden /> ดูสรุปงาน
      </Button>
      <Button type="button" onClick={onSave} disabled={saving}>
        <Check aria-hidden /> บันทึก / อัปเดต
      </Button>
    </div>
  );
}
