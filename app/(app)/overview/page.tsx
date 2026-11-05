import { redirect } from "next/navigation";
import { getWorkspace } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";
import { JoinDemo } from "@/components/join-demo";
import { PageTitle } from "@/components/page-title";
import {
  canApprove,
  isLabelWideUser,
  canOpenEventDetail,
  canViewOverview,
  canViewGroup,
} from "@/lib/permissions";
import { OverviewClient } from "@/components/overview/overview-client";
import { loadOverviewData } from "@/components/overview/overview-data";
import { assertReadsSucceeded } from "@/lib/read-guard";
import { bkkTodayKey } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const ws = await getWorkspace();
  if (!ws.membership || !ws.tenant) return <JoinDemo />;
  // Anyone in at least one band may open Overview; a user with no band and no
  // label-wide standing has nothing to see, so bounce them like /admin does.
  if (!canViewOverview(ws.perms)) redirect("/dashboard");
  const tid = ws.membership.tenant_id;

  // Scope to the bands this user may view. RLS is tenant-wide (every member can
  // read every band/event), so a band-only Ar/member is narrowed HERE: label-wide
  // → all bands, otherwise only their own. Drives both the events query and the
  // band list, so each band sees only its own schedule.
  const viewableGroups = ws.groups.filter((g) => canViewGroup(ws.perms, g.id));
  // Approve/reject is for approvers (admin / label_staff); others see status only.
  const canApproveEvents = canApprove(ws.perms);
  const supabase = await createClient();

  // Every read and the whole assembly live in overview-data.ts, shared with the
  // desktop board. A FAILED READ IS NOT A ZERO COUNT (lib/read-guard.ts): it is
  // thrown into app/(app)/error.tsx, which renders the retryable card - overview-data.ts
  // says at each of its two phases what a swallowed failure would show instead.
  const load = await loadOverviewData(supabase, {
    tenantId: tid,
    groups: viewableGroups,
    perms: ws.perms,
  });
  if (!load.ok) {
    // `failed` always holds an error, so this throws; "abandoned" needs a
    // stillWanted callback, which this page never passes.
    if ("failed" in load) assertReadsSucceeded("OverviewPage", load.failed);
    throw new Error("OverviewPage: the overview load did not finish");
  }
  const { events, bands, staff, runOrderFestivals } = load.data;

  return (
    <div className="space-y-4">
      <PageTitle
        title="Overview"
        right={
          <span className="pb-0.5 text-right text-[13px] leading-tight text-muted-foreground">
            {ws.tenant.name}
            <br />
            <span className="num text-[17px] text-foreground">{viewableGroups.length}</span> วง ·{" "}
            <span className="num text-[17px] text-foreground">{events.length}</span> งาน
          </span>
        }
      />

      {bands.length === 0 ? (
        <p className="rounded-[2px] border border-dashed border-border py-16 text-center text-muted-foreground">
          ยังไม่มีวง — เพิ่มที่หน้า “วง”
        </p>
      ) : (
        <OverviewClient
          events={events}
          bands={bands}
          staffContacts={staff}
          labelName={ws.tenant.name}
          canApproveEvents={canApproveEvents}
          isLabelWide={isLabelWideUser(ws.perms)}
          canOpenDetail={canOpenEventDetail()}
          isLabelStaff={ws.perms.tenantRole === "label_staff"}
          runOrderFestivals={runOrderFestivals}
          todayKey={bkkTodayKey()}
        />
      )}
    </div>
  );
}
