"use client";

import { useEffect, useState } from "react";
import { Music2, Dumbbell, NotebookPen } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PracticePlayer } from "@/components/practice/practice-player";
import { PracticeJournal } from "@/components/practice/practice-journal";
import type { Member, Song, SongMarker, PracticeSong } from "@/lib/types";

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
  practiceList,
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
  practiceList: PracticeSong[];
  markersBySong: Record<string, SongMarker[]>;
  members: Member[];
  canManage: boolean;
  currentUserId: string;
}) {
  const [runSignal, setRunSignal] = useState(0);
  // The practice list lives HERE (above the Tabs) so it survives switching to the
  // journal tab and back — the player unmounts on tab switch, so its own state would
  // reset to the stale server prop and "lose" songs you just added.
  const [practiceItems, setPracticeItems] = useState(() =>
    practiceList.slice().sort((a, b) => a.sort_order - b.sort_order)
  );
  // Section markers live here for the same reason: a mark added in the player, then
  // hidden by a tab switch, used to come back missing (and re-marking it inserted a
  // duplicate song_markers row).
  const [markers, setMarkers] = useState<Record<string, SongMarker[]>>(markersBySong);

  // Practice writes (this room's song list + section markers) are a BAND activity:
  // any member of the band curates them, but a label-wide READ-ONLY observer (CEO),
  // who can VIEW every band, must not. canManage (= canEditGroup) can't be that gate
  // — it's false for plain members too — so ask once whether this user holds a role
  // IN this band: the UI mirror of the practice write gate (can_edit_group OR a
  // group_roles row for the band). Unknown (still loading / offline) keeps the
  // controls, so a member at a venue is never locked out of their own practice list;
  // RLS stays the real boundary.
  const [inThisBand, setInThisBand] = useState(true);
  useEffect(() => {
    if (canManage) return; // admin / the band's Ar — already an editor
    let alive = true;
    createClient()
      .from("group_roles")
      .select("role")
      .eq("group_id", groupId)
      .eq("user_id", currentUserId)
      .then(({ data, error }) => {
        // a failed read must not hide a member's own controls
        if (!alive || error || !data) return;
        setInThisBand(data.length > 0);
      });
    return () => {
      alive = false;
    };
  }, [groupId, currentUserId, canManage]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <Music2 className="h-5 w-5" /> {roomName}
        </h1>
        <p className="text-xs text-muted-foreground">
          Training — ปรับความเร็ว, วนท่อน, จับเวลาพัก และจดบันทึกการซ้อม
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
            items={practiceItems}
            setItems={setPracticeItems}
            markers={markers}
            setMarkers={setMarkers}
            canManage={canManage}
            canCurate={canManage || inThisBand}
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
