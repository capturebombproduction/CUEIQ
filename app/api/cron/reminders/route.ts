import { NextResponse } from "next/server";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { pushToUsers } from "@/lib/notify-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Daily reminder job (Vercel Cron → see vercel.json). Vercel sends
// `Authorization: Bearer ${CRON_SECRET}` to cron paths, so we gate on that.
// Idempotent: re-running within ~20h won't double-notify (dedupe on type+event).
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function bandName(groups: unknown): string {
  const g = Array.isArray(groups) ? groups[0] : groups;
  return (g as { name?: string } | null)?.name ?? "";
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasServiceRole()) return NextResponse.json({ error: "no service role" }, { status: 503 });

  const admin = createAdminClient();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const in2days = new Date(now.getTime() + 2 * 86_400_000).toISOString();
  const dedupeSince = new Date(now.getTime() - 20 * 3_600_000).toISOString();

  let inserted = 0;
  let pushed = 0;

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
    const { data: existing } = await admin
      .from("notifications")
      .select("user_id")
      .eq("type", type)
      .eq("meta->>event_id", eventId)
      .gt("created_at", dedupeSince);
    const got = new Set((existing ?? []).map((r) => r.user_id as string));
    const targets = ids.filter((id) => !got.has(id));
    if (targets.length === 0) return;
    const link = `/events/${eventId}`;
    await admin.from("notifications").insert(
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
    inserted += targets.length;
    pushed += await pushToUsers(admin, targets, { title, body, link });
  }

  // 1) Upcoming shows today / tomorrow → the whole band (Ar + members).
  const { data: shows } = await admin
    .from("events")
    .select("id, name, group_id, tenant_id, event_date, groups(name)")
    .eq("is_template", false)
    .eq("is_practice", false)
    .gte("event_date", today)
    .lte("event_date", tomorrow);
  for (const ev of shows ?? []) {
    const { data: roles } = await admin
      .from("group_roles")
      .select("user_id")
      .eq("group_id", ev.group_id as string);
    const band = bandName(ev.groups);
    const when = ev.event_date === today ? "วันนี้" : "พรุ่งนี้";
    await fan(
      ev.id as string,
      ev.group_id as string,
      ev.tenant_id as string,
      (roles ?? []).map((r) => r.user_id as string),
      "event_reminder",
      `📅 โชว์${when}`,
      band ? `${ev.name} · ${band}` : (ev.name as string)
    );
  }

  // 2) Deadlines within the next 2 days that aren't approved yet → the band's Ar.
  const { data: deadlines } = await admin
    .from("events")
    .select("id, name, group_id, tenant_id, deadline, status, groups(name)")
    .eq("is_template", false)
    .eq("is_practice", false)
    .not("deadline", "is", null)
    .gte("deadline", now.toISOString())
    .lte("deadline", in2days)
    .neq("status", "approved");
  for (const ev of deadlines ?? []) {
    const { data: roles } = await admin
      .from("group_roles")
      .select("user_id")
      .eq("group_id", ev.group_id as string)
      .eq("role", "artist_manager");
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

  return NextResponse.json({ ok: true, inserted, pushed });
}
