"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardList, Check } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/refresh-button";
import { ShareButton } from "@/components/event/share-button";
import { ScheduleEditor } from "@/components/event/schedule-editor";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import { MicMapEditor } from "@/components/event/mic-map-editor";
import { LineupEditor } from "@/components/event/lineup-editor";
import { EventSummary } from "@/components/event/event-summary";
import { type RunSeqLive } from "@/components/event/event-live-caller";
import { createClient } from "@/lib/supabase/client";
import { notify } from "@/lib/notify-client";
import { type CompletenessResult } from "@/lib/completeness";
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
  // before router.refresh() lands the new status.
  const status = event.status as GroupStatus;
  const syncing = useRef(false);
  useEffect(() => {
    if (!editable || event.is_template || syncing.current) return;
    let next: GroupStatus | null = null;
    if (status === "draft" && completeness.complete) next = "pending_review";
    else if (status === "pending_review" && !completeness.complete) next = "draft";
    if (!next) return;
    syncing.current = true;
    const target = next;
    (async () => {
      const { error } = await createClient()
        .from("events")
        .update({ status: target })
        .eq("id", eventId);
      if (error) {
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
  // remember the tab in the URL hash so a reload returns here (not back to Summary).
  // Read it AFTER mount to avoid a hydration mismatch.
  const [view, setView] = useState<string>("summary");
  useEffect(() => {
    const h = window.location.hash.replace("#", "");
    if (["summary", "setlist", "schedule", "mic", "lineup"].includes(h)) setView(h);
  }, []);

  function changeView(v: string) {
    setView(v);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${v}`);
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

        <TabsContent value="setlist">
          <SetlistBuilder
            eventId={eventId}
            tenantId={tenantId}
            editable={editable}
            initialItems={setlist}
            showStartTime={showStartTime}
            hardOutTime={hardOutTime}
            members={members}
            songs={songs}
          />
        </TabsContent>

        <TabsContent value="schedule">
          <ScheduleEditor
            eventId={eventId}
            tenantId={tenantId}
            editable={editable}
            initialItems={schedule}
          />
        </TabsContent>

        <TabsContent value="lineup">
          <LineupEditor
            eventId={eventId}
            tenantId={tenantId}
            editable={editable}
            members={members}
            initialLineup={lineup}
          />
        </TabsContent>

        {modules.micMap && (
          <TabsContent value="mic">
            <MicMapEditor
              eventId={eventId}
              tenantId={tenantId}
              editable={editable}
              initialMics={micMap}
              members={members}
              setlist={setlist}
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
