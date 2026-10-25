import { NextResponse } from "next/server";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { pushToUsers } from "@/lib/notify-server";
import { cronSecretMatches, reportCronFailure } from "@/lib/cron-report";
import { approvalNagBody, approvalsNeedingNag } from "@/lib/approval-nag";
import { expireSupersededDailyNotifications } from "@/lib/notification-expiry";
import { callTimeByEvent, showReminderBody } from "@/lib/next-show";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Daily reminder job (Vercel Cron → see vercel.json). Three blocks: a show today
// or tomorrow, a deadline inside two days, and an approval request nobody has
// answered. Vercel sends
// `Authorization: Bearer ${CRON_SECRET}` to cron paths, so we gate on that
// (constant-time — see cronSecretMatches). Idempotent: re-running within ~20h
// won't double-notify (dedupe on type+event).
//
// Runs unattended like the backup job, so the same rule applies: an unhandled
// failure mid-run gets written to client_errors (kind: "cron") via
// reportCronFailure instead of vanishing — surfaced in the admin Dev Inbox —
// and a genuinely failed run returns a non-200 status. The unauthorized (401)
// branch is deliberately NOT reported this way — see reportCronFailure's doc
// comment for why.
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  return cronSecretMatches(req.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

function bandOf(groups: unknown): { name?: string; exempt_from_deadline?: boolean } | null {
  const g = Array.isArray(groups) ? groups[0] : groups;
  return (g as { name?: string; exempt_from_deadline?: boolean } | null) ?? null;
}

function bandName(groups: unknown): string {
  return bandOf(groups)?.name ?? "";
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    // Not reported to client_errors: this route is reachable by anyone (cron
    // paths are excluded from middleware auth), so an unauthenticated request
    // proves nothing about whether CRON_SECRET is actually misconfigured — a
    // scanner hitting this URL would otherwise plant a false alarm that also
    // occupies the dedupe window, silencing that day's REAL failure report.
    // A genuinely rotated secret still shows up in Vercel's own invocation log.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!hasServiceRole()) return NextResponse.json({ error: "no service role" }, { status: 503 });

  try {
    return await runReminders();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await reportCronFailure("reminders", `run failed: ${detail}`);
    return NextResponse.json({ error: "reminder run failed", detail }, { status: 500 });
  }
}

async function runReminders(): Promise<Response> {
  const admin = createAdminClient();
  const now = new Date();
  // ⚠️ THE UTC DATE, and that is load-bearing for block 3 below. vercel.json runs
  // this at 01:00 UTC = 08:00 in Bangkok, so the UTC calendar day and the label's
  // are the same day at the moment it runs. Move the schedule EARLIER than 07:00
  // Bangkok and they diverge: `event_date < today` would then read a show on its
  // own day as already past and go silent on the last morning anyone could
  // approve it. Change the cron expression and this line together, or not at all.
  const today = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const in2days = new Date(now.getTime() + 2 * 86_400_000).toISOString();
  const dedupeSince = new Date(now.getTime() - 20 * 3_600_000).toISOString();

  let inserted = 0;
  let pushed = 0;

  // Every read and write below that the reminders depend on reports its own failure
  // instead of reading as "nothing to do". Each one used to coalesce a failed answer
  // to an empty list: a broken shows query was a quiet day, a broken band-roles read
  // was a band with nobody in it, and the run said ok:true — the exact silence the
  // header promises this job never has. Worse, a failed dedupe read looked like
  // "nobody has been told yet" and the whole band got the same push twice. A failure
  // skips only its own step (one band's broken read must not cost another band its
  // reminder); the run then reports what failed and answers 500.
  const failures: string[] = [];
  const failed = (step: string, error: { message: string }) => {
    failures.push(`${step}: ${error.message}`);
  };

  // 0) Yesterday's reminders are superseded by today's (or about something that
  // is over) — stop them counting as unread, or the bell sits at "9+" for good and
  // buries the rows that matter. See lib/notification-expiry.ts. Housekeeping
  // must never cost the day's reminders, so a failure here is reported and passed.
  let expired = 0;
  try {
    expired = await expireSupersededDailyNotifications(admin, {
      before: dedupeSince,
      now: now.toISOString(),
    });
  } catch (e) {
    // Its OWN report key: reportCronFailure dedupes per key for 6 h, so filing a
    // housekeeping hiccup under "reminders" would silence the real "run failed"
    // report if the reminders themselves then broke in the same run.
    await reportCronFailure(
      "reminders/expiry",
      e instanceof Error ? e.message : String(e)
    );
  }

  // Insert + push a reminder to recipients who haven't already gotten this one.
  async function fan(
    eventId: string,
    groupId: string,
    tenantId: string,
    recipientIds: string[],
    type: string,
    title: string,
    body: string
  ) {
    const ids = Array.from(new Set(recipientIds));
    if (ids.length === 0) return;
    const { data: existing, error: dedupeError } = await admin
      .from("notifications")
      .select("user_id")
      .eq("type", type)
      .eq("meta->>event_id", eventId)
      .gt("created_at", dedupeSince);
    // No answer to "who has already been told" = no reminder. Guessing "nobody" is
    // how a re-run pushed the same reminder to the whole band again.
    if (dedupeError) return failed(`dedupe ${type} ${eventId}`, dedupeError);
    const got = new Set((existing ?? []).map((r) => r.user_id as string));
    const targets = ids.filter((id) => !got.has(id));
    if (targets.length === 0) return;
    const link = `/events/${eventId}`;
    const { error: insertError } = await admin.from("notifications").insert(
      targets.map((uid) => ({
        tenant_id: tenantId,
        user_id: uid,
        type,
        title,
        body,
        link,
        meta: { event_id: eventId, group_id: groupId },
      }))
    );
    // Not pushed either: the row is what the bell shows and what the dedupe above
    // reads, so a push without one is a reminder a re-run would send again.
    if (insertError) return failed(`insert ${type} ${eventId}`, insertError);
    inserted += targets.length;
    // A failed push_subscriptions read throws (lib/notify-server.ts): report it as this
    // step's failure - never "nobody has a device", never the rest of the run (2026-10-25).
    try {
      pushed += await pushToUsers(admin, targets, { title, body, link });
    } catch (e) {
      return failed(`push ${type} ${eventId}`, { message: e instanceof Error ? e.message : String(e) });
    }
  }

  // 1) Upcoming shows today / tomorrow → the whole band (Ar + members).
  const { data: shows, error: showsError } = await admin
    .from("events")
    .select("id, name, group_id, tenant_id, event_date, show_start_time, groups(name)")
    .eq("is_template", false)
    .eq("is_practice", false)
    .gte("event_date", today)
    .lte("event_date", tomorrow);
  if (showsError) failed("shows", showsError);
  // Their call times, for the reminder's body (lib/next-show.ts). Best-effort: a
  // failed read sends the reminder as it always was — name and band.
  const showIds = (shows ?? []).map((e) => e.id as string);
  const { data: scheduleRows } = showIds.length
    ? await admin
        .from("schedule_items")
        .select("event_id, start_time, kind")
        .in("event_id", showIds)
    : { data: [] };
  const callTimes = callTimeByEvent(
    (scheduleRows ?? []) as { event_id: string; start_time: string | null; kind: string | null }[],
    Object.fromEntries((shows ?? []).map((e) => [e.id as string, e.show_start_time as string | null]))
  );
  for (const ev of shows ?? []) {
    const { data: roles, error: rolesError } = await admin
      .from("group_roles")
      .select("user_id")
      .eq("group_id", ev.group_id as string);
    if (rolesError) {
      failed(`band roles ${ev.id}`, rolesError);
      continue;
    }
    const band = bandName(ev.groups);
    const when = ev.event_date === today ? "วันนี้" : "พรุ่งนี้";
    await fan(
      ev.id as string,
      ev.group_id as string,
      ev.tenant_id as string,
      (roles ?? []).map((r) => r.user_id as string),
      "event_reminder",
      `📅 โชว์${when}`,
      showReminderBody(
        ev.name as string,
        band,
        callTimes[ev.id as string],
        ev.show_start_time as string | null
      )
    );
  }

  // 2) Deadlines within the next 2 days that aren't approved yet → the band's Ar.
  const { data: deadlines, error: deadlinesError } = await admin
    .from("events")
    .select("id, name, group_id, tenant_id, deadline, status, groups(name, exempt_from_deadline)")
    .eq("is_template", false)
    .eq("is_practice", false)
    .not("deadline", "is", null)
    .gte("deadline", now.toISOString())
    .lte("deadline", in2days)
    .neq("status", "approved");
  if (deadlinesError) failed("deadlines", deadlinesError);
  for (const ev of deadlines ?? []) {
    // A band exempt from deadlines (0009) never sees one in the app — DeadlineChip
    // hides it — so it must not be woken up by a push about one either.
    if (bandOf(ev.groups)?.exempt_from_deadline) continue;
    const { data: roles, error: rolesError } = await admin
      .from("group_roles")
      .select("user_id")
      .eq("group_id", ev.group_id as string)
      .eq("role", "artist_manager");
    if (rolesError) {
      failed(`band managers ${ev.id}`, rolesError);
      continue;
    }
    const band = bandName(ev.groups);
    await fan(
      ev.id as string,
      ev.group_id as string,
      ev.tenant_id as string,
      (roles ?? []).map((r) => r.user_id as string),
      "event_deadline",
      "⏰ ใกล้ถึงกำหนดส่งงาน",
      band ? `${ev.name} · ${band}` : (ev.name as string)
    );
  }

  // 3) Submissions the approvers have not answered. THE ONE THAT CAME FROM REAL
  // DATA: "Gorya seitan sai" was submitted 2026-07-15 for a 2026-07-19 show and
  // was still pending_review six weeks later. /api/notify tells the approvers
  // ONCE, at submit time, and nothing has ever mentioned it again — so a show
  // went ahead with a call sheet no admin had checked. The whole rule (grace
  // period, and the deliberate silence once the show has passed) lives in
  // lib/approval-nag.ts, tested there and proven red.
  const { data: pending, error: pendingError } = await admin
    .from("events")
    .select("id, name, group_id, tenant_id, event_date, status, updated_at, groups(name)")
    .eq("is_template", false)
    .eq("is_practice", false)
    .eq("status", "pending_review")
    .gte("event_date", today);
  if (pendingError) failed("pending approvals", pendingError);
  const waiting = approvalsNeedingNag(
    (pending ?? []).map((e) => ({
      id: e.id as string,
      status: e.status as string,
      event_date: (e.event_date as string | null) ?? null,
      updated_at: e.updated_at as string,
    })),
    now,
    today
  );
  if (waiting.length) {
    // Approvers are tenant-wide (admin / label_staff), the same set /api/notify
    // reaches for event_submitted — NOT the band's own Ar, who is the person
    // waiting for the answer and would only be told about their own patience.
    const { data: approvers, error: approversError } = await admin
      .from("tenant_members")
      .select("user_id, tenant_id")
      .in("role", ["admin", "label_staff"]);
    if (approversError) failed("approvers", approversError);
    for (const row of approversError ? [] : waiting) {
      const ev = (pending ?? []).find((e) => e.id === row.id);
      if (!ev) continue;
      const ids = (approvers ?? [])
        .filter((a) => a.tenant_id === ev.tenant_id)
        .map((a) => a.user_id as string);
      await fan(
        ev.id as string,
        ev.group_id as string,
        ev.tenant_id as string,
        ids,
        "event_awaiting_approval",
        "\u{1F7E0} มีงานรออนุมัติ",
        approvalNagBody(row, now, bandName(ev.groups), ev.name as string)
      );
    }
  }

  if (failures.length) {
    // Everything that could still go out has gone out; now say what could not. Same
    // key as a thrown run (reportCronFailure dedupes per key), so one bad morning is
    // one row in the Dev Inbox, not one per step.
    await reportCronFailure("reminders", `incomplete run: ${failures.join("; ")}`, {
      failures,
      inserted,
      pushed,
      expired,
    });
    return NextResponse.json(
      { error: "reminder run incomplete", failures, inserted, pushed, expired },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, inserted, pushed, expired });
}
