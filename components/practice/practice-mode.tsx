"use client";

import { useEffect, useState } from "react";
import { Headphones, NotebookPen } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { hasLiveSession } from "@/lib/auth-session";
import {
  canWriteJournal,
  membershipFromProbe,
  type BandMembership,
} from "@/lib/practice-journal-gate";
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
  //
  // The verdict goes through lib/practice-journal-gate.ts, which is also what the
  // journal tab uses. It has to: this probe used to end with
  // `setInThisBand(data.length > 0)`, and an empty read is NOT an empty table —
  // supabase-js falls back to the anon key for ~a minute after a failed token
  // refresh, and RLS answers anon with `data: [], error: null`. So during a venue
  // reconnect a genuine member watched add-song / reorder / section-marker vanish
  // from THIS tab (one-shot probe, so gone until remount) while the สมุดซ้อม tab,
  // which already used membershipFromProbe, kept their composer. One user, one
  // screen, two opposite answers — and this was the half that failed CLOSED.
  //
  // canWriteJournal despite the name: practice_songs/song_markers (0038 §2 C13)
  // and practice_logs (0041) carry the identical write clause.
  const [membership, setMembership] = useState<BandMembership>("unknown");
  useEffect(() => {
    if (canManage) return; // admin / the band's Ar — already an editor
    let alive = true;
    (async () => {
      const { data, error } = await createClient()
        .from("group_roles")
        .select("role")
        .eq("group_id", groupId)
        .eq("user_id", currentUserId);
      if (!alive) return;
      // a failed read must not hide a member's own controls, and an empty answer
      // is only believable when the request actually went out signed
      const rows = error || !data ? null : data.length;
      const signedIn = rows === 0 ? await hasLiveSession() : true;
      if (!alive) return;
      setMembership(membershipFromProbe(rows, signedIn));
    })();
    return () => {
      alive = false;
    };
  }, [groupId, currentUserId, canManage]);
  const canCurate = canWriteJournal(canManage, membership);

  return (
    <div className="space-y-3">
      {/* The room's name is the page's heading (it is what someone typed, so it is
          set as typed — never the caps H1); "Training" above it is the place. */}
      <div className="min-w-0">
        <p className="eyebrow text-muted-foreground">Practice Room</p>
        <h1 className="mt-0.5 truncate text-[20px] font-semibold leading-tight">{roomName}</h1>
      </div>

      <Tabs defaultValue="player">
        <TabsList className="sm:max-w-sm">
          <TabsTrigger value="player">
            <Headphones className="h-4 w-4" aria-hidden /> เครื่องเล่น
          </TabsTrigger>
          <TabsTrigger value="journal">
            <NotebookPen className="h-4 w-4" aria-hidden /> สมุดซ้อม
          </TabsTrigger>
        </TabsList>

        <TabsContent value="player" className="mt-3">
          <PracticePlayer
            roomName={roomName}
            eventId={eventId}
            groupId={groupId}
            currentUserId={currentUserId}
            songs={songs}
            items={practiceItems}
            setItems={setPracticeItems}
            markers={markers}
            setMarkers={setMarkers}
            canManage={canManage}
            canCurate={canCurate}
            onRunLogged={() => setRunSignal((n) => n + 1)}
          />
        </TabsContent>

        <TabsContent value="journal" className="mt-3">
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
