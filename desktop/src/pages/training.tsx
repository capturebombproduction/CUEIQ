// Desktop Training (ห้องซ้อม) — mirrors app/(app)/practice/page.tsx. Lists the
// band's practice rooms (events flagged is_practice); each opens the practice
// player. Reuses PracticeRoomList / CreatePracticeButton verbatim.
import { useEffect, useState } from "react";
import { Headphones } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { RefreshButton } from "@/components/refresh-button";
import { Card, CardContent } from "@/components/ui/card";
import { CreatePracticeButton } from "@/components/practice/create-practice-button";
import { PracticeRoomList, type PracticeRoomRow } from "@/components/practice/practice-room-list";
import {
  loadPracticeRoomStats,
  type PracticeRoomStats,
} from "@/components/practice/practice-room-stats";
import { createClient } from "@/lib/supabase/client";
import { canEditGroup, viewableGroups } from "@/lib/permissions";
import type { EventRow } from "@/lib/types";
import { useWorkspace } from "~/data/workspace-context";

type Room = EventRow & PracticeRoomRow;

export function Training() {
  const { ws } = useWorkspace();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  // What each room's slab says. Loaded after the rooms, and optional: offline it
  // simply stays undefined and the rooms list without numbers.
  const [stats, setStats] = useState<Record<string, PracticeRoomStats> | undefined>(undefined);
  const ids = ws ? viewableGroups(ws.perms, ws.groups).map((g) => g.id) : [];
  const key = ids.join(",");

  useEffect(() => {
    if (!ws?.membership) return;
    if (ids.length === 0) {
      setRooms([]);
      return;
    }
    let alive = true;
    const sb = createClient();
    sb.from("events")
      .select("*, groups(name, color)")
      .eq("tenant_id", ws.membership.tenant_id)
      .in("group_id", ids)
      .eq("is_practice", true)
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (!alive) return;
        // postgrest resolves offline/network failures as { data: null, error } —
        // don't render "ยังไม่มีห้องซ้อม" for a failed read.
        if (error) {
          setLoadError(true);
          return;
        }
        setLoadError(false);
        const list = (data ?? []) as Room[];
        setRooms(list);
        loadPracticeRoomStats(
          sb,
          list.map((r) => r.id)
        )
          .then((s) => {
            if (alive) setStats(s);
          })
          .catch(() => {});
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
    // data-stage-centred: one centred column, so the frame keeps the light centred
    // on it at lg (components/stage-light.tsx FRAME_LIGHT_AIM)
    <div data-stage-centred className="mx-auto max-w-3xl space-y-4">
      <PageTitle
        title="Training"
        right={
          editableGroups.length > 0 && rooms && rooms.length > 0 ? (
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

      {rooms === null && loadError ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted-foreground">
            <p>โหลดห้องซ้อมไม่สำเร็จ — อาจออฟไลน์อยู่หรือเน็ตมีปัญหา ลองใหม่เมื่อเน็ตกลับมา</p>
            <RefreshButton label="ลองใหม่" />
          </CardContent>
        </Card>
      ) : rooms === null ? (
        <p className="py-12 text-center text-sm text-muted-foreground">กำลังโหลด…</p>
      ) : rooms.length === 0 ? (
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

      {editableGroups.length === 0 && rooms && rooms.length > 0 && (
        <p className="text-[12.5px] text-muted-foreground">สร้างห้องซ้อมได้เฉพาะ Ar ของวง</p>
      )}
    </div>
  );
}
