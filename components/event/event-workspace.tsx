"use client";

import { useState } from "react";
import { ClipboardList } from "lucide-react";
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
  const [view, setView] = useState<string>("summary");

  return (
    <div className="w-full space-y-4">
      {/* Big Summary button (default view) + refresh */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="lg"
          variant={view === "summary" ? "default" : "outline"}
          onClick={() => setView("summary")}
          className="font-semibold"
        >
          <ClipboardList className="h-5 w-5" /> สรุปงาน (Summary)
        </Button>
        <RefreshButton />
      </div>

      <Tabs value={view} onValueChange={setView} className="w-full">
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
            onNavigate={setView}
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
    </div>
  );
}
