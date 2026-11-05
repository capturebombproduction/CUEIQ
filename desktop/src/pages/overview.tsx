// Desktop Overview — mirrors app/(app)/overview/page.tsx. The reads and the data
// assembly are the web's own (components/overview/overview-data.ts, run client-side
// here), then OverviewClient is reused verbatim (the festival schedule board).
// Scoped to the bands the user may view.
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { PageTitle } from "@/components/page-title";
import { RefreshButton } from "@/components/refresh-button";
import { createClient } from "@/lib/supabase/client";
import {
  canApprove,
  canOpenEventDetail,
  canViewGroup,
  canViewOverview,
  isLabelWideUser,
} from "@/lib/permissions";
import { OverviewClient } from "@/components/overview/overview-client";
import { loadOverviewData, type OverviewData } from "@/components/overview/overview-data";
import { useWorkspace } from "~/data/workspace-context";

export function Overview() {
  const { ws } = useWorkspace();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const viewable = ws ? ws.groups.filter((g) => canViewGroup(ws.perms, g.id)) : [];
  const ids = viewable.map((g) => g.id);
  const key = ids.join(",");

  useEffect(() => {
    if (!ws?.membership || ids.length === 0) {
      if (ws?.membership) setData({ events: [], bands: [], staff: [], runOrderFestivals: [] });
      return;
    }
    let alive = true;
    const tid = ws.membership.tenant_id;
    const sb = createClient();
    (async () => {
      const load = await loadOverviewData(sb, {
        tenantId: tid,
        groups: viewable,
        perms: ws.perms,
        // Unmounted while phase 1 was in flight — don't fire phase 2 into the void.
        stillWanted: () => alive,
      });
      // postgrest resolves offline/network failures as { data: null, error } (RLS
      // never errors, it filters) — a failed read is NOT an empty festival board, so
      // never render "0 งาน" for one. Any failed part is fatal here: the board mixes
      // every read, and a half-loaded running order is worse than none.
      if (!load.ok) {
        if (alive) setLoadError(true);
        return;
      }
      if (alive) {
        setLoadError(false);
        setData(load.data);
      }
    })().catch(() => alive && setLoadError(true));
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
  if (!canViewOverview(ws.perms)) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          บัญชีนี้ไม่มีสิทธิ์ดู Overview
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <PageTitle
        title="Overview"
        right={
          <span className="pb-0.5 text-right text-[13px] leading-tight text-muted-foreground">
            {ws.tenant.name}
            <br />
            <span className="num text-[17px] text-foreground">{viewable.length}</span> วง
            {data ? (
              <>
                {" "}
                · <span className="num text-[17px] text-foreground">{data.events.length}</span> งาน
              </>
            ) : null}
          </span>
        }
      />

      {data === null && loadError ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
            <p>โหลด Overview ไม่สำเร็จ — อาจออฟไลน์อยู่หรือเน็ตมีปัญหา ลองใหม่เมื่อเน็ตกลับมา</p>
            <RefreshButton label="ลองใหม่" />
          </CardContent>
        </Card>
      ) : data === null ? (
        <p className="py-16 text-center text-sm text-muted-foreground">กำลังโหลด…</p>
      ) : data.bands.length === 0 ? (
        <p className="rounded-[2px] border border-dashed border-border py-16 text-center text-muted-foreground">
          ยังไม่มีวง — เพิ่มที่หน้า “วง”
        </p>
      ) : (
        <OverviewClient
          events={data.events}
          bands={data.bands}
          staffContacts={data.staff}
          labelName={ws.tenant.name}
          canApproveEvents={canApprove(ws.perms)}
          isLabelWide={isLabelWideUser(ws.perms)}
          canOpenDetail={canOpenEventDetail()}
          isLabelStaff={ws.perms.tenantRole === "label_staff"}
          runOrderFestivals={data.runOrderFestivals}
        />
      )}
    </div>
  );
}
