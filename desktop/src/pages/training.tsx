// Desktop Training (ห้องซ้อม) — mirrors app/(app)/practice/page.tsx. Lists the
// band's practice rooms (events flagged is_practice); each opens the practice
// player. Reuses CreatePracticeButton / DeletePracticeRoomButton verbatim.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Dumbbell, Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CreatePracticeButton } from "@/components/practice/create-practice-button";
import { DeletePracticeRoomButton } from "@/components/practice/delete-practice-room-button";
import { createClient } from "@/lib/supabase/client";
import { canEditGroup, viewableGroups } from "@/lib/permissions";
import type { EventRow } from "@/lib/types";
import { useWorkspace } from "~/data/workspace-context";

type Room = EventRow & { groups: { name: string; color: string | null } | null };

export function Training() {
  const { ws } = useWorkspace();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const ids = ws ? viewableGroups(ws.perms, ws.groups).map((g) => g.id) : [];
  const key = ids.join(",");

  useEffect(() => {
    if (!ws?.membership) return;
    if (ids.length === 0) {
      setRooms([]);
      return;
    }
    let alive = true;
    createClient()
      .from("events")
      .select("*, groups(name, color)")
      .eq("tenant_id", ws.membership.tenant_id)
      .in("group_id", ids)
      .eq("is_practice", true)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (alive) setRooms((data ?? []) as Room[]);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.membership?.tenant_id, key]);

  if (!ws?.membership || !ws.user) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          บัญชีนี้ยังไม่ได้ผูกกับ Label
        </CardContent>
      </Card>
    );
  }

  const editableGroups = ws.groups
    .filter((g) => canEditGroup(ws.perms, g.id))
    .map((g) => ({ id: g.id, name: g.name }));
  const tid = ws.membership.tenant_id;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Dumbbell className="h-6 w-6" /> Training
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            ห้องซ้อมของวง — เปิดเพลงจากคลัง, ปรับความเร็ว, วนท่อน, จับเวลาพัก และจดบันทึกการซ้อม
          </p>
        </div>
        {editableGroups.length > 0 && (
          <CreatePracticeButton tenantId={tid} userId={ws.user.id} groups={editableGroups} />
        )}
      </div>

      {rooms === null ? (
        <p className="py-12 text-center text-sm text-muted-foreground">กำลังโหลด…</p>
      ) : rooms.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted-foreground">
            <Dumbbell className="h-8 w-8 opacity-40" />
            <p>ยังไม่มีห้องซ้อม</p>
            {editableGroups.length > 0 ? (
              <CreatePracticeButton
                tenantId={tid}
                userId={ws.user.id}
                groups={editableGroups}
                label="สร้างห้องซ้อมแรก"
              />
            ) : (
              <p>ขอให้ Ar ของวงสร้างห้องซ้อมให้</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rooms.map((room) => (
            <Card key={room.id} className="transition-colors hover:bg-muted/40">
              <CardContent className="flex items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className="h-9 w-1.5 shrink-0 rounded-full"
                    style={{ background: room.groups?.color ?? "var(--muted)" }}
                  />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{room.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {room.groups?.name ?? "—"}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button asChild size="sm">
                    <Link to={`/events/${room.id}/practice`}>
                      <Play className="h-4 w-4" /> เข้าซ้อม
                    </Link>
                  </Button>
                  {canEditGroup(ws.perms, room.group_id) && (
                    <DeletePracticeRoomButton roomId={room.id} roomName={room.name} />
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editableGroups.length === 0 && rooms && rooms.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Plus className="h-3.5 w-3.5" /> สร้างห้องซ้อมได้เฉพาะ Ar ของวง
        </p>
      )}
    </div>
  );
}
