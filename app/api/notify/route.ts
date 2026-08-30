import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient as createTokenClient } from "@supabase/supabase-js";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { vapidConfigured, sendPush } from "@/lib/push";
import {
  runOrderLinksFor,
  runOrderPushBody,
  RUN_ORDER_FALLBACK_LINK,
  type FestivalEvent,
  type GroupRoleRow,
} from "@/lib/dead-link";

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
  | "run_order_live" // → everyone in the tenant (the show just went live)
  | "feedback_replied"; // → the ONE person who wrote the feedback

const EVENT_KINDS = new Set<Kind>(["event_submitted", "event_approved", "event_rejected"]);
const SONG_KINDS = new Set<Kind>(["song_pending", "song_rejected", "song_cleared"]);
const RUN_ORDER_KINDS = new Set<Kind>(["run_order_live"]);
const FEEDBACK_KINDS = new Set<Kind>(["feedback_replied"]);

// CORS — the WEB app calls this same-origin (these headers are inert there). The
// DESKTOP app calls it cross-origin with a Bearer token (no cookies), and the
// Authorization header forces a preflight — mirror /api/audio/presign. Auth is
// still the real gate (a valid session/token + tenant-membership check below).
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(req) });
}

const noOp = (req: Request) => json(req, { ok: true, sent: 0 });

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

/** Resolve the caller's Supabase client: a Bearer token (desktop, cross-origin)
 *  takes precedence; otherwise the cookie session (web, same-origin) — the same
 *  scheme as /api/audio/presign. */
async function callerClient(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (token) {
    return createTokenClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.trim(),
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      }
    );
  }
  return createServerClient();
}

export async function POST(req: Request) {
  // 1) The caller must be a logged-in user (cookie session or Bearer token).
  const supabase = await callerClient(req);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json(req, { error: "unauthorized" }, 401);

  // Notifications need the service role to write rows for OTHER users + read their
  // push subscriptions. Absent → silently no-op (the app still works).
  if (!hasServiceRole()) return noOp(req);

  const body = await req.json().catch(() => null);
  const kind = body?.kind as Kind;
  const eventId = typeof body?.eventId === "string" ? body.eventId : null;
  const songId = typeof body?.songId === "string" ? body.songId : null;
  const feedbackId = typeof body?.feedbackId === "string" ? body.feedbackId : null;
  if (
    !kind ||
    (!EVENT_KINDS.has(kind) &&
      !SONG_KINDS.has(kind) &&
      !RUN_ORDER_KINDS.has(kind) &&
      !FEEDBACK_KINDS.has(kind))
  ) {
    return json(req, { error: "bad kind" }, 400);
  }

  const admin = createAdminClient();

  // 2) Resolve the subject (event or song), its band + current state.
  let tenantId: string;
  let groupId = "";
  let bandName: string;
  let title: string;
  let messageBody: string;
  let link: string;
  let recipientRule: "approvers" | "band_ar" | "all_tenant" | "submitter";
  // feedback_replied only — the single person the answer belongs to.
  let submitterId = "";
  const meta: Record<string, unknown> = {};
  // run_order_live only — the festival identity + the event the board was opened
  // from, needed below to give each recipient a link THEY can open (see step 4c).
  let festivalName = "";
  let festivalDate: string | null = null;
  let entryEventId = "";

  if (EVENT_KINDS.has(kind)) {
    if (!eventId) return json(req, { error: "no eventId" }, 400);
    const { data: ev } = await admin
      .from("events")
      .select("id, name, group_id, tenant_id, status, groups(name)")
      .eq("id", eventId)
      .maybeSingle();
    if (!ev) return noOp(req);
    // anti-spoof: the real status must match the claimed kind
    const want =
      kind === "event_submitted" ? "pending_review" : kind === "event_approved" ? "approved" : "rejected";
    if (ev.status !== want) return noOp(req);
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
    if (!songId) return json(req, { error: "no songId" }, 400);
    const { data: sg } = await admin
      .from("songs")
      .select("id, title, group_id, tenant_id, copyright_status, groups(name)")
      .eq("id", songId)
      .maybeSingle();
    if (!sg) return noOp(req);
    const want =
      kind === "song_pending" ? "pending" : kind === "song_rejected" ? "rejected" : "cleared";
    if (sg.copyright_status !== want) return noOp(req);
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
  } else if (FEEDBACK_KINDS.has(kind)) {
    // feedback_replied — an admin answered someone's report in the Dev Inbox.
    //
    // Unlike every other kind here, this one has no public state to re-verify
    // against: "an admin replied" IS the state. So it is authorized directly —
    // the caller must be an admin of the report's tenant — and the reply must
    // actually be on the row. Both checks run with the admin client so a member
    // cannot use their own RLS view to make either come out differently.
    if (!feedbackId) return json(req, { error: "no feedbackId" }, 400);
    const { data: fb } = await admin
      .from("feedback")
      .select("id, tenant_id, user_id, reply, message")
      .eq("id", feedbackId)
      .maybeSingle();
    if (!fb) return noOp(req);
    if (!(fb.reply as string | null)?.trim()) return noOp(req); // nothing was said
    if (!fb.user_id) return noOp(req); // author's account is gone
    tenantId = fb.tenant_id as string;
    submitterId = fb.user_id as string;
    const { data: callerRole } = await admin
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .maybeSingle();
    // can_admin_tenant's role set, evaluated here rather than through the rpc so it
    // cannot be answered by the caller's own session.
    if (!["admin", "platform_admin", "tenant_owner"].includes(String(callerRole?.role))) {
      return json(req, { error: "forbidden" }, 403);
    }
    title = "💬 ทีมงานตอบฟีดแบคของคุณแล้ว";
    // The first line of what they originally wrote, so the push says WHICH report.
    const asked = (fb.message as string) ?? "";
    messageBody = asked.length > 80 ? `${asked.slice(0, 80)}…` : asked;
    link = "/feedback";
    recipientRule = "submitter";
    meta.feedback_id = fb.id;
  } else {
    // run_order_live — the festival's live board just started. Everyone in the
    // label watches the show, so notify the whole tenant. Anti-spoof: the festival
    // (tenant + name + date, resolved from the event the board was opened for) must
    // actually have a row gone live.
    if (!eventId) return json(req, { error: "no eventId" }, 400);
    const { data: ev } = await admin
      .from("events")
      .select("id, name, tenant_id, event_date")
      .eq("id", eventId)
      .maybeSingle();
    if (!ev) return noOp(req);
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
    if (!liveCount) return noOp(req); // not actually live → don't notify
    title = "🔴 งานเริ่มแล้ว (Live)";
    // The DEFAULT link for this kind is the everyone-safe one. It used to be
    // `/events/${ev.id}/run-order/live` — the entry event, i.e. whichever single
    // band's event the caller happened to open the board from — while the audience
    // is the WHOLE label. events_select is can_view_group(group_id), so the members
    // and Ar of the other 7 bands could not read that row: the live page's
    // `.single()` came back null and called notFound(). Twelve to fifteen of the 19
    // accounts got a push on their phone and a bare 404 at the exact minute the show
    // started. Step 4c below upgrades this to a per-recipient deep link wherever one
    // provably exists; anything it cannot resolve stays on this fallback, because a
    // duller destination beats a dead one and this fires on show day.
    link = RUN_ORDER_FALLBACK_LINK;
    recipientRule = "all_tenant";
    meta.event_id = ev.id;
    entryEventId = ev.id as string;
    festivalName = (ev.name as string) ?? "";
    festivalDate = (ev.event_date as string | null) ?? null;
    // The body has to agree with the LINK, not with the kind: whoever ends up on the
    // /overview fallback cannot reach the live board from there, so they must not be
    // told to open it. This is the default (fallback) wording; step 4c upgrades it
    // per recipient wherever it also upgrades the link. See runOrderPushBody.
    messageBody = runOrderPushBody(festivalName, link);
    // The board is festival-wide (one run_sequence per tenant + name + date) but is
    // reachable from ANY member event's page, so remember the FESTIVAL identity and
    // dedupe on that below — keying on the entry-point event id would let a restart
    // from another band's page re-blast the whole label.
    meta.festival = `${tenantId}|${(ev.name as string) ?? ""}|${(ev.event_date as string) ?? ""}`;
  }

  // 3) The caller must belong to the subject's tenant (blocks cross-tenant spam).
  const { data: callerMember } = await admin
    .from("tenant_members")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!callerMember) return json(req, { error: "forbidden" }, 403);

  // 4) Resolve recipient user ids.
  let recipientIds: string[] = [];
  if (recipientRule === "submitter") {
    recipientIds = [submitterId];
  } else if (recipientRule === "all_tenant") {
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
  if (recipientIds.length === 0) return noOp(req);

  // 4b) Dedupe against recent identical notifications (mirrors the cron fan()):
  // the anti-spoof status stays true for a window (a run_sequence is 'live' for the
  // whole show), so without this ANY member — or a stuck client retry loop — could
  // re-blast the same push to the whole tenant in a loop. But real state transitions
  // legitimately repeat inside that window (reject → fix → auto-resubmit), and there
  // is no history to fall back on, so the guard must never swallow the DURABLE bell
  // row: only someone who STILL has that exact item unread is skipped outright (it
  // is already sitting in their bell); everyone else gets the row and only the
  // redundant PUSH is held back.
  const dedupeMs = kind === "run_order_live" ? 10 * 60_000 : 5 * 60_000;
  const dedupeSince = new Date(Date.now() - dedupeMs).toISOString();
  const subjectCol = SONG_KINDS.has(kind)
    ? "meta->>song_id"
    : kind === "run_order_live"
      ? "meta->>festival"
      : FEEDBACK_KINDS.has(kind)
        ? "meta->>feedback_id"
        : "meta->>event_id";
  const subjectId = String(
    SONG_KINDS.has(kind)
      ? meta.song_id
      : kind === "run_order_live"
        ? meta.festival
        : FEEDBACK_KINDS.has(kind)
          ? meta.feedback_id
          : meta.event_id
  );
  const { data: already } = await admin
    .from("notifications")
    .select("user_id, read_at")
    .eq("type", kind)
    .eq(subjectCol, subjectId)
    .gt("created_at", dedupeSince);
  const recent = already ?? [];
  const stillUnread = new Set(
    recent.filter((r) => !r.read_at).map((r) => r.user_id as string)
  );
  const pushedRecently = new Set(recent.map((r) => r.user_id as string));
  recipientIds = recipientIds.filter((id) => !stillUnread.has(id));
  if (recipientIds.length === 0) return noOp(req);

  // 4c) run_order_live only: the audience is the whole label but the live board is
  // reached through SOME event row, and RLS only lets a band-tier account read the
  // events of their own band(s). So resolve the destination per recipient instead of
  // shipping one band's event id to all 19 people. The board itself is festival-wide
  // (run_sequence is keyed on tenant + name + date, never on an event id), so every
  // link below opens the SAME board — they differ only in which door they use.
  //
  // Every read here is best-effort ON PURPOSE: a failure leaves that recipient on
  // the /overview fallback, which is never a 404. Nothing in this block may make the
  // notification worse than not sending the deep link at all.
  const linkFor = new Map<string, string>();
  if (kind === "run_order_live") {
    let fq = admin
      .from("events")
      .select("id, group_id")
      .eq("tenant_id", tenantId)
      .eq("name", festivalName);
    fq = festivalDate ? fq.eq("event_date", festivalDate) : fq.is("event_date", null);
    const [{ data: festEvents }, { data: memberRows }] = await Promise.all([
      fq,
      admin
        .from("tenant_members")
        .select("user_id, role")
        .eq("tenant_id", tenantId)
        .in("user_id", recipientIds),
    ]);
    const festivalEvents: FestivalEvent[] = (festEvents ?? []).map((e) => ({
      id: e.id as string,
      group_id: (e.group_id as string | null) ?? null,
    }));
    const bandIds = Array.from(
      new Set(festivalEvents.map((e) => e.group_id).filter((g): g is string => !!g))
    );
    let groupRoles: GroupRoleRow[] = [];
    if (bandIds.length) {
      const { data: grRows } = await admin
        .from("group_roles")
        .select("user_id, group_id")
        .in("group_id", bandIds)
        .in("user_id", recipientIds);
      groupRoles = (grRows ?? []).map((r) => ({
        user_id: r.user_id as string,
        group_id: r.group_id as string,
      }));
    }
    for (const [uid, dest] of runOrderLinksFor({
      recipientIds,
      members: (memberRows ?? []).map((m) => ({
        user_id: m.user_id as string,
        role: (m.role as string | null) ?? null,
      })),
      festivalEvents,
      groupRoles,
      entryEventId,
    })) {
      linkFor.set(uid, dest);
    }
  }
  const linkOf = (uid: string) => linkFor.get(uid) ?? link;
  // …and the body is resolved from that same link, never separately: a push that
  // promises the live board to someone whose destination has no way into it is the
  // same broken promise as the dead link it replaced, just one step further along.
  const bodyOf = (uid: string) =>
    kind === "run_order_live" ? runOrderPushBody(festivalName, linkOf(uid)) : messageBody;

  // 5) Insert the in-app rows.
  const rows = recipientIds.map((uid) => ({
    tenant_id: tenantId,
    user_id: uid,
    type: kind,
    title,
    body: bodyOf(uid),
    link: linkOf(uid),
    meta,
  }));
  await admin.from("notifications").insert(rows);

  // 6) Web Push (best-effort; prune dead subscriptions) — only to recipients who
  // did NOT already get a push for this exact (type, subject) inside the window.
  const pushIds = recipientIds.filter((id) => !pushedRecently.has(id));
  let sent = 0;
  if (vapidConfigured() && pushIds.length) {
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth")
      .in("user_id", pushIds);
    // The payload SHAPE is unchanged ({title, body, link}) — phones already hold
    // subscriptions and public/sw.js reads exactly these three fields — but the link
    // AND the body are now resolved per subscription owner, the same pair stored in
    // that person's bell row. A push and a bell item that disagree about where to go
    // would be worse than either bug alone.
    const dead: string[] = [];
    await Promise.all(
      (subs ?? []).map(async (s) => {
        const res = await sendPush(
          { endpoint: s.endpoint as string, p256dh: s.p256dh as string, auth: s.auth as string },
          {
            title,
            body: bodyOf(s.user_id as string),
            link: linkOf(s.user_id as string),
          }
        );
        if (res === "ok") sent++;
        else if (res === "gone") dead.push(s.id as string);
      })
    );
    if (dead.length) await admin.from("push_subscriptions").delete().in("id", dead);
  }

  return json(req, { ok: true, recipients: recipientIds.length, sent });
}
