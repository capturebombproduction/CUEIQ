// Desktop จัดการวง (Artists) — mirrors app/(app)/groups/page.tsx. Reuses
// GroupManager verbatim (band + roster CRUD), scoped to the bands the user may view.
import { useEffect, useState } from "react";
import { RefreshButton } from "@/components/refresh-button";
import { GroupManager } from "@/components/group/group-manager";
import { Card, CardContent } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import { viewableGroups } from "@/lib/permissions";
import type { Member } from "@/lib/types";
import { useWorkspace } from "~/data/workspace-context";

export function Artists() {
  const { ws } = useWorkspace();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const bands = ws ? viewableGroups(ws.perms, ws.groups) : [];
  const ids = bands.map((g) => g.id);
  const key = ids.join(",");

  useEffect(() => {
    if (!ws?.membership) return;
    if (ids.length === 0) {
      setMembers([]);
      return;
    }
    let alive = true;
    createClient()
      .from("members")
      .select("*")
      .eq("tenant_id", ws.membership.tenant_id)
      .in("group_id", ids)
      .order("group_id", { ascending: true })
      .order("sort_order", { ascending: true })
      .then(({ data, error }) => {
        if (!alive) return;
        // postgrest resolves offline/network failures as { data: null, error } —
        // don't render an empty roster for a failed read.
        if (error) {
          setLoadError(true);
          return;
        }
        setLoadError(false);
        setMembers((data ?? []) as Member[]);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.membership?.tenant_id, key]);

  if (!ws?.membership || !ws.tenant) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          บัญชีนี้ยังไม่ได้ผูกกับ Label
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">จัดการวง</h1>
          <p className="text-sm text-muted-foreground">
            {ws.tenant.name} · {bands.length} วง
          </p>
        </div>
        <RefreshButton />
      </div>
      {members === null && loadError ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
            <p>โหลดข้อมูลวงไม่สำเร็จ — อาจออฟไลน์อยู่หรือเน็ตมีปัญหา ลองใหม่เมื่อเน็ตกลับมา</p>
            <RefreshButton label="ลองใหม่" />
          </CardContent>
        </Card>
      ) : members === null ? (
        <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลด…</p>
      ) : (
        <GroupManager
          tenantId={ws.membership.tenant_id}
          initialGroups={bands}
          initialMembers={members}
          perms={ws.perms}
        />
      )}
    </div>
  );
}
