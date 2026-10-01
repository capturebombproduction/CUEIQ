import { redirect } from "next/navigation";
import { Headphones } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/queries";
import { canEditGroup, viewableGroups } from "@/lib/permissions";
import { CreatePracticeButton } from "@/components/practice/create-practice-button";
import { PracticeRoomList, type PracticeRoomRow } from "@/components/practice/practice-room-list";
import { loadPracticeRoomStats } from "@/components/practice/practice-room-stats";
import { PageTitle } from "@/components/page-title";
import type { EventRow } from "@/lib/types";

export const dynamic = "force-dynamic";

// โหมดซ้อม home: lists this user's practice rooms (events flagged is_practice) for
// the bands they can see, and lets an Ar/admin spin up a new one. Members may open
// + play; only the band's Ar (or admin) can create a room.
export default async function PracticePage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.user) redirect("/dashboard");
  // label_staff is an overview-only role — practice is a band activity.
  if (ws.perms.tenantRole === "label_staff") redirect("/overview");

  const supabase = await createClient();
  const tid = ws.membership.tenant_id;
  // Per-band scope: a band-tier user sees only their own band's practice rooms;
  // admin/ceo see every band's.
  const viewableGroupIds = viewableGroups(ws.perms, ws.groups).map((g) => g.id);
  const { data } = await supabase
    .from("events")
    .select("*, groups(name, color)")
    .eq("tenant_id", tid)
    .in("group_id", viewableGroupIds) // only bands this user may view
    .eq("is_practice", true)
    .order("created_at", { ascending: false });

  const rooms = (data ?? []) as (EventRow & PracticeRoomRow)[];
  // What each room's slab says (songs, homework, problems, last session). Display
  // only; a read that fails leaves its numbers out rather than showing 0.
  const stats = await loadPracticeRoomStats(
    supabase,
    rooms.map((r) => r.id)
  ).catch(() => undefined);

  // Bands the user may create a practice room for (admin → all; Ar → their bands).
  const editableGroups = ws.groups
    .filter((g) => canEditGroup(ws.perms, g.id))
    .map((g) => ({ id: g.id, name: g.name }));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle
        title="Training"
        right={
          editableGroups.length > 0 && rooms.length > 0 ? (
            <CreatePracticeButton
              tenantId={tid}
              userId={ws.user.id}
              groups={editableGroups}
              label="ห้องใหม่"
            />
          ) : null
        }
      />
      <p className="text-[13px] text-muted-foreground">
        ห้องซ้อมของวง — เปิดเพลงจากคลัง, ปรับความเร็ว, วนท่อน, จับเวลาพัก และจดบันทึกการซ้อม
      </p>

      {rooms.length === 0 ? (
        <div className="slab flex flex-col items-center gap-3 px-4 py-12 text-center text-sm text-muted-foreground">
          <Headphones className="h-8 w-8 opacity-40" aria-hidden />
          <p>ยังไม่มีห้องซ้อม</p>
          {editableGroups.length > 0 ? (
            <CreatePracticeButton
              tenantId={tid}
              userId={ws.user.id}
              groups={editableGroups}
              label="สร้างห้องซ้อมแรก"
              variant="default"
            />
          ) : (
            <p>ขอให้ Ar ของวงสร้างห้องซ้อมให้</p>
          )}
        </div>
      ) : (
        <PracticeRoomList
          rooms={rooms}
          stats={stats}
          deletableIds={rooms.filter((r) => canEditGroup(ws.perms, r.group_id)).map((r) => r.id)}
        />
      )}

      {editableGroups.length === 0 && rooms.length > 0 && (
        <p className="text-[12.5px] text-muted-foreground">สร้างห้องซ้อมได้เฉพาะ Ar ของวง</p>
      )}
    </div>
  );
}
