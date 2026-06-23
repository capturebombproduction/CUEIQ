import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { vapidConfigured, sendPush } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The notification kinds the client can request after a mutation. Each is tied to
// a REAL state we re-verify server-side (so a notify call can't fabricate a status
// that didn't actually happen), and a recipient rule.
type Kind =
  | "event_submitted" // → approvers (admin / label_staff)
  | "event_approved" // → the band's Ar(s)
  | "event_rejected" // → the band's Ar(s)
  | "song_pending" // → approvers
  | "song_rejected" // → the band's Ar(s)
  | "song_cleared" // → the band's Ar(s)
  | "run_order_live"; // → everyone in the tenant (the show just went live)

const EVENT_KINDS = new Set<Kind>(["event_submitted", "event_approved", "event_rejected"]);
const SONG_KINDS = new Set<Kind>(["song_pending", "song_rejected", "song_cleared"]);
const RUN_ORDER_KINDS = new Set<Kind>(["run_order_live"]);

const NO_OP = NextResponse.json({ ok: true, sent: 0 });

export async function POST(req: Request) {
  // 1) The caller must be a logged-in user (their session, via RLS-bound client).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Notifications need the service role to write rows for OTHER users + read their
  // push subscriptions. Absent → silently no-op (the app still works).
  if (!hasServiceRole()) return NO_OP;

  const body = await req.json().catch(() => null);
  const kind = body?.kind as Kind;
  const eventId = typeof body?.eventId === "string" ? body.eventId : null;
  const songId = typeof body?.songId === "string" ? body.songId : null;
  if (
    !kind ||
    (!EVENT_KINDS.has(kind) && !SONG_KINDS.has(kind) && !RUN_ORDER_KINDS.has(kind))
  ) {
    return NextResponse.json({ error: "bad kind" }, { status: 400 });
  }

  const admin = createAdminClient();

  // 2) Resolve the subject (event or song), its band + current state.
  let tenantId: string;
  let groupId = "";
  let bandName: string;
  let title: string;
  let messageBody: string;
  let link: string;
  let recipientRule: "approvers" | "band_ar" | "all_tenant";
  const meta: Record<string, unknown> = {};

  if (EVENT_KINDS.has(kind)) {
    if (!eventId) return NextResponse.json({ error: "no eventId" }, { status: 400 });
    const { data: ev } = await admin
      .from("events")
      .select("id, name, group_id, tenant_id, status, groups(name)")
      .eq("id", eventId)
      .maybeSingle();
    if (!ev) return NO_OP;
    // anti-spoof: the real status must match the claimed kind
    const want =
      kind === "event_submitted" ? "pending_review" : kind === "event_approved" ? "approved" : "rejected";
    if (ev.status !== want) return NO_OP;
    tenantId = ev.tenant_id as string;
    groupId = ev.group_id as string;
    bandName = (ev.groups as { name?: string } | null)?.name ?? "";
    meta.event_id = ev.id;
    meta.group_id = groupId;
    const name = (ev.name as string) || "งาน";
    if (kind === "event_submitted") {
      title = "📋 งานรออนุมัติ";
      link = "/overview";
      recipientRule = "approvers";
    } else if (kind === "event_approved") {
      title = "✅ อนุมัติงานแล้ว";
      link = `/events/${ev.id}`;
      recipientRule = "band_ar";
    } else {
      title = "↩️ งานถูกตีกลับ";
      link = `/events/${ev.id}`;
      recipientRule = "band_ar";
    }
    messageBody = bandName ? `${name} · ${bandName}` : name;
  } else if (SONG_KINDS.has(kind)) {
    if (!songId) return NextResponse.json({ error: "no songId" }, { status: 400 });
    const { data: sg } = await admin
      .from("songs")
      .select("id, title, group_id, tenant_id, copyright_status, groups(name)")
      .eq("id", songId)
      .maybeSingle();
    if (!sg) return NO_OP;
    const want =
      kind === "song_pending" ? "pending" : kind === "song_rejected" ? "rejected" : "cleared";
    if (sg.copyright_status !== want) return NO_OP;
    tenantId = sg.tenant_id as string;
    groupId = sg.group_id as string;
    bandName = (sg.groups as { name?: string } | null)?.name ?? "";
    meta.song_id = sg.id;
    meta.group_id = groupId;
    const name = (sg.title as string) || "เพลง";
    if (kind === "song_pending") {
      title = "🎵 เพลงใหม่รอตรวจลิขสิทธิ์";
      recipientRule = "approvers";
    } else if (kind === "song_rejected") {
      title = "⛔ เพลงถูกปฏิเสธลิขสิทธิ์";
      recipientRule = "band_ar";
    } else {
      title = "✅ เพลงผ่านลิขสิทธิ์";
      recipientRule = "band_ar";
    }
    link = "/library";
    messageBody = bandName ? `${name} · ${bandName}` : name;
  } else {
    // run_order_live — the festival's live board just started. Everyone in the
    // label watches the show, so notify the whole tenant. Anti-spoof: the festival
    // (tenant + name + date, resolved from the event the board was opened for) must
    // actually have a row gone live.
    if (!eventId) return NextResponse.json({ error: "no eventId" }, { status: 400 });
    const { data: ev } = await admin
      .from("events")
      .select("id, name, tenant_id, event_date")
      .eq("id", eventId)
      .maybeSingle();
    if (!ev) return NO_OP;
    tenantId = ev.tenant_id as string;
    let liveQ = admin
      .from("run_sequence")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("event_name", ev.name as string)
      .eq("status", "live");
    liveQ = ev.event_date
      ? liveQ.eq("event_date", ev.event_date as string)
      : liveQ.is("event_date", null);
    const { count: liveCount } = await liveQ;
    if (!liveCount) return NO_OP; // not actually live → don't notify
    title = "🔴 งานเริ่มแล้ว (Live)";
    messageBody = `${(ev.name as string) || "งาน"} — เปิดดูคิวงานสดได้เลย`;
    link = `/events/${ev.id}/run-order/live`;
    recipientRule = "all_tenant";
    meta.event_id = ev.id;
  }

  // 3) The caller must belong to the subject's tenant (blocks cross-tenant spam).
  const { data: callerMember } = await admin
    .from("tenant_members")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!callerMember) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // 4) Resolve recipient user ids.
  let recipientIds: string[] = [];
  if (recipientRule === "all_tenant") {
    const { data } = await admin
      .from("tenant_members")
      .select("user_id")
      .eq("tenant_id", tenantId);
    recipientIds = (data ?? []).map((r) => r.user_id as string);
  } else if (recipientRule === "approvers") {
    const { data } = await admin
      .from("tenant_members")
      .select("user_id, role")
      .eq("tenant_id", tenantId)
      .in("role", ["admin", "label_staff"]);
    recipientIds = (data ?? []).map((r) => r.user_id as string);
  } else {
    const { data } = await admin
      .from("group_roles")
      .select("user_id")
      .eq("group_id", groupId)
      .eq("role", "artist_manager");
    recipientIds = (data ?? []).map((r) => r.user_id as string);
  }
  // de-dupe + never notify the person who triggered it
  recipientIds = Array.from(new Set(recipientIds)).filter((id) => id !== user.id);
  if (recipientIds.length === 0) return NO_OP;

  // 5) Insert the in-app rows.
  const rows = recipientIds.map((uid) => ({
    tenant_id: tenantId,
    user_id: uid,
    type: kind,
    title,
    body: messageBody,
    link,
    meta,
  }));
  await admin.from("notifications").insert(rows);

  // 6) Web Push (best-effort; prune dead subscriptions).
  let sent = 0;
  if (vapidConfigured()) {
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth")
      .in("user_id", recipientIds);
    const payload = { title, body: messageBody, link };
    const dead: string[] = [];
    await Promise.all(
      (subs ?? []).map(async (s) => {
        const res = await sendPush(
          { endpoint: s.endpoint as string, p256dh: s.p256dh as string, auth: s.auth as string },
          payload
        );
        if (res === "ok") sent++;
        else if (res === "gone") dead.push(s.id as string);
      })
    );
    if (dead.length) await admin.from("push_subscriptions").delete().in("id", dead);
  }

  return NextResponse.json({ ok: true, recipients: recipientIds.length, sent });
}
