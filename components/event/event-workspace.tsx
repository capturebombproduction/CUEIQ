"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

  return (
    <Tabs defaultValue="summary" className="w-full">
      <TabsList className="flex h-auto w-full flex-wrap justify-start">
        <TabsTrigger value="summary">สรุป</TabsTrigger>
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
  );
}
