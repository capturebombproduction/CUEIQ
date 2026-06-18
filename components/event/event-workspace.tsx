"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardList, Check } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/refresh-button";
import { ScheduleEditor } from "@/components/event/schedule-editor";
import { SetlistBuilder } from "@/components/event/setlist-builder";
import { MicMapEditor } from "@/components/event/mic-map-editor";
import { EventSummary } from "@/components/event/event-summary";
import {
  EVENT_TYPES,
  type EventRow,
  type EventType,
  type Group,
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
  eventType,
  showStartTime,
  hardOutTime,
  schedule,
  setlist,
  micMap,
  members,
  songs,
}: {
  event: EventRow & { group: Group | null };
  eventId: string;
  tenantId: string;
  editable: boolean;
  eventType: EventType;
  showStartTime: string | null;
  hardOutTime: string | null;
  schedule: ScheduleItem[];
  setlist: SetlistItem[];
  micMap: MicAssignment[];
  members: Member[];
  songs: Song[];
}) {
  const modules = EVENT_TYPES[eventType]?.modules ?? EVENT_TYPES.idol.modules;
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  // remember the tab in the URL hash so a reload returns here (not back to Summary).
  // Read it AFTER mount to avoid a hydration mismatch.
  const [view, setView] = useState<string>("summary");
  useEffect(() => {
    const h = window.location.hash.replace("#", "");
    if (["summary", "setlist", "schedule", "mic"].includes(h)) setView(h);
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
    toast.success("บันทึก/อัปเดตข้อมูลเรียบร้อยแล้ว", {
      description: "ระบบบันทึกอัตโนมัติทุกครั้งที่แก้ไขอยู่แล้ว",
    });
    setTimeout(() => setSaving(false), 800);
  }

  return (
    <div className="w-full space-y-4">
      {/* Big Summary button (default view) + refresh */}
      <div className="flex flex-wrap items-center gap-2">
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
      </div>

      <Tabs value={view} onValueChange={changeView} className="w-full">
        <TabsList className="flex h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="setlist">Setlist + Run Time</TabsTrigger>
          <TabsTrigger value="schedule">นัดหมาย</TabsTrigger>
          {modules.micMap && <TabsTrigger value="mic">Mic Map</TabsTrigger>}
        </TabsList>

        <TabsContent value="summary">
          <EventSummary
            event={event}
            schedule={schedule}
            setlist={setlist}
            members={members}
            showMic={modules.micMap}
            onNavigate={changeView}
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
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3">
          <span className="mr-1 text-xs text-muted-foreground">
            บันทึกอัตโนมัติทุกครั้งที่แก้ไข
          </span>
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
