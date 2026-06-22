import { redirect } from "next/navigation";
import Link from "next/link";
import { Dumbbell, Play, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getWorkspace } from "@/lib/queries";
import { canEditGroup, viewableGroups } from "@/lib/permissions";
import { CreatePracticeButton } from "@/components/practice/create-practice-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

  const supabase = createClient();
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

  const rooms = (data ?? []) as (EventRow & {
    groups: { name: string; color: string | null } | null;
  })[];

  // Bands the user may create a practice room for (admin → all; Ar → their bands).
  const editableGroups = ws.groups
    .filter((g) => canEditGroup(ws.perms, g.id))
    .map((g) => ({ id: g.id, name: g.name }));

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
          <CreatePracticeButton
            tenantId={tid}
            userId={ws.user.id}
            groups={editableGroups}
          />
        )}
      </div>

      {rooms.length === 0 ? (
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
                <Button asChild size="sm">
                  <Link href={`/events/${room.id}/practice`}>
                    <Play className="h-4 w-4" /> เข้าซ้อม
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editableGroups.length === 0 && rooms.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Plus className="h-3.5 w-3.5" /> สร้างห้องซ้อมได้เฉพาะ Ar ของวง
        </p>
      )}
    </div>
  );
}
