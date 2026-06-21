"use client";

import { useState } from "react";
import { Music2, Dumbbell, NotebookPen } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PracticePlayer } from "@/components/practice/practice-player";
import { PracticeJournal } from "@/components/practice/practice-journal";
import type { Member, Song, SongMarker } from "@/lib/types";

/**
 * Practice Mode shell — two tabs: the player (เครื่องเล่น: slow-down, markers, A-B
 * loop, break timer) and the journal (สมุดซ้อม: notes/problems/summary/homework,
 * attendance, auto-logged songs, history). Auto-logged practice runs from the player
 * bump a signal so the journal's "ซ้อมวันนี้" refreshes when you open it.
 */
export function PracticeMode({
  roomName,
  eventId,
  groupId,
  tenantId,
  songs,
  markersBySong,
  members,
  canManage,
  currentUserId,
}: {
  roomName: string;
  eventId: string;
  groupId: string;
  tenantId: string;
  songs: Song[];
  markersBySong: Record<string, SongMarker[]>;
  members: Member[];
  canManage: boolean;
  currentUserId: string;
}) {
  const [runSignal, setRunSignal] = useState(0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <Music2 className="h-5 w-5" /> {roomName}
        </h1>
        <p className="text-xs text-muted-foreground">
          โหมดซ้อม — ปรับความเร็ว, วนท่อน, จับเวลาพัก และจดบันทึกการซ้อม
        </p>
      </div>

      <Tabs defaultValue="player">
        <TabsList>
          <TabsTrigger value="player">
            <Dumbbell className="mr-1.5 h-4 w-4" /> เครื่องเล่น
          </TabsTrigger>
          <TabsTrigger value="journal">
            <NotebookPen className="mr-1.5 h-4 w-4" /> สมุดซ้อม
          </TabsTrigger>
        </TabsList>

        <TabsContent value="player" className="mt-4">
          <PracticePlayer
            eventId={eventId}
            currentUserId={currentUserId}
            songs={songs}
            markersBySong={markersBySong}
            canManage={canManage}
            onRunLogged={() => setRunSignal((n) => n + 1)}
          />
        </TabsContent>

        <TabsContent value="journal" className="mt-4">
          <PracticeJournal
            eventId={eventId}
            groupId={groupId}
            tenantId={tenantId}
            members={members}
            canManage={canManage}
            currentUserId={currentUserId}
            refreshSignal={runSignal}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
