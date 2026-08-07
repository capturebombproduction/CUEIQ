// Persisted live-authority helpers (P2) over the show_authority table (mig 0035).
// They are the SYNCED MIRROR of each device's local role — the realtime hand-off
// still rides the existing live: broadcast channel; this layer lets a device that
// joins / reconnects / was offline SEE who holds a role, recover a ghost main
// (a holder whose heartbeat went stale), and (P3) decide a rank override.
//
// Every call is best-effort: offline or any error resolves to a no-op / empty so
// it can NEVER block or break the zero-tolerance live path. See
// docs/offline-first-plan.md §3/§6/§7.

// Absolute path (not "./supabase/client") so the desktop build's
// "@/lib/supabase/client" alias swaps in the localStorage-backed client too —
// a relative import would bypass the alias and pull the web's cookie client,
// which can't authenticate under Electron's file:// origin.
import { createClient } from "@/lib/supabase/client";
import type { Role } from "./types";

export type AuthorityKind = "show_main" | "audio_host";

export interface AuthorityRow {
  event_id: string;
  kind: AuthorityKind;
  device_id: string;
  device_label: string | null;
  by_user_id: string | null;
  by_role: string | null;
  claimed_at: string;
  heartbeat_at: string;
}

// Break-glass rank (higher = more authority): member < Ar < label_staff < ceo < admin.
const RANK: Record<string, number> = {
  member: 0,
  artist_manager: 1,
  label_staff: 2,
  ceo: 3,
  admin: 4,
};

export function rankOf(role: string | null | undefined): number {
  return role ? (RANK[role] ?? 0) : 0;
}

/** A strictly higher rank may force-take a role from the current holder (P3). */
export function canOverride(
  holderRole: string | null,
  myRole: string | null
): boolean {
  return rankOf(myRole) > rankOf(holderRole);
}

// A claim is "live" only while its heartbeat is fresh; older = ghost (the holding
// device crashed / left without releasing) → safe for another device to reclaim.
export const GHOST_MS = 90_000;

// ─── Clock skew: the two clocks in this comparison are NOT the same clock ───────
//
// `heartbeat_at` is stamped by the HOLDER's wall clock — claimAuthority and
// heartbeatAuthority below both send `new Date().toISOString()`, which overrides
// the `default now()` the table declares in 0035_show_authority.sql — and isGhost
// compares it against the OBSERVER's wall clock.
//
// The incident it produces: the PA desktop at the venue has been off-network for
// days (Windows w32time syncs weekly and does nothing at all without a route out)
// and its clock has drifted two minutes slow. It IS show_main and it is
// heartbeating happily every 30s (live-mode.tsx's authority effect) — but every
// heartbeat it writes is stamped two minutes in the past as far as every
// NTP-synced phone in the room is concerned. `now - heartbeat_at` = 120s > 90s,
// so every other device declares the working PA dead: live-status-strip raises the
// amber "MAIN เดิมหลุด" badge whose tooltip tells the reader to press ขอควบคุม, and
// live-mode's otherDeviceHoldsShow() stops seeing the holder, so pressing เริ่มโชว์
// on a phone skips the "โชว์กำลังรันอยู่บนเครื่องอื่น" confirmation. The margin used
// to be GHOST_MS minus the 30s heartbeat interval = SIXTY SECONDS of clock
// disagreement between two devices that never compare clocks. That is nothing.
//
// ⚠️ WHAT THIS ACTUALLY IS — do not read more into it than the code does. It is a
// FLAT 120s of extra slack in the window, and NOTHING here measures anybody's
// clock. Round 10 first shipped it dressed as a measured correction: an exported
// clockSkewMs() plus a third `skewMs` argument on isGhost, with the flat grace
// described as the "no measurement available" fallback. The round-10 review then
// established by grep that no caller anywhere passed that argument — the measured
// branch was unreachable code and this comment was advertising a capability the
// product did not have. Both were DELETED rather than wired, because wiring them
// is neither cheap nor safe:
//
//   The authority row is keyed by `device_id` (lib/device-id.ts — persisted, one
//   per machine). The only per-peer timestamp we ever receive is `sentAt` on the
//   live: broadcast, and that payload identifies its sender as `meId`, a
//   per-page-instance crypto.randomUUID() (live-mode.tsx). There is no field
//   linking the two. Wiring the parameter therefore means adding a device_id to
//   the broadcast payload plus a per-device skew registry — a new cross-device
//   field and new state — and mapping it to the WRONG row would hand an
//   unmeasured holder a zero allowance, narrowing its window straight back to 90s
//   and re-creating the incident above on exactly the devices least able to
//   survive it. A dead parameter is a documentation bug; a mis-mapped one stops
//   a show.
//
// THE REAL FIX, deliberately NOT done here: stamp the SERVER clock instead of the
// client's — a `before insert or update on public.show_authority` trigger setting
// `new.heartbeat_at = now()`. That makes heartbeat_at skew-free for every client at
// once, including the v0.1.7/0.1.8 installs already in the field that will never be
// updated before the next show. It needs a migration; this round ships none, so the
// flat grace below is the client-side stand-in until that migration lands.
//
// ⚠️ BUT THE TRIGGER IS NOT THE EXIT CONDITION, and an earlier version of this
// paragraph said it was: "put the window back to a tight 90s … delete
// CLOCK_SKEW_GRACE_MS on the day the trigger exists." Following that instruction
// re-arms this incident, in the direction that stops a show. The grace below is
// SYMMETRIC — it forgives 120s of disagreement whichever side drifts. The trigger
// is ONE-SIDED: it fixes only the RIGHT term of `now - heartbeat_at` — `heartbeat_at`
// itself, the holder's stamp. The LEFT term, `now`, is still
// the OBSERVER's Date.now(), because both production call sites take the default
// (live-status-strip.tsx's refreshAuthority `isGhost(main)`, live-mode.tsx's
// otherDeviceHoldsShow `!isGhost(r)` — named, not numbered, because a line number in a
// 3900-line file is wrong the next time anyone edits above it, and this one already was), so
// the comparison stays server-time-minus-observer-wall-clock and the incident
// survives, mirrored onto the observer. Same venue, roles swapped: the PA desktop
// is two minutes FAST and the show is being driven from a phone, so the PA is now
// the observer. The server-stamped heartbeat lands at real T, the PA computes
// now - t = +120s > 90s and declares the healthy phone dead — live-status-strip
// raises the amber "MAIN เดิมหลุด" badge on the desk running the sound, and
// otherDeviceHoldsShow() filters the live holder out with `!isGhost(r)` and returns
// null, so pressing เริ่มโชว์ on the PA skips the "โชว์กำลังรันอยู่บนเครื่อง X —
// ยืนยันไหม?" confirm entirely and starts, resetting the running show to item 0 with
// a fresh clock and muting the phone. That silent skip is precisely the failure
// otherDeviceHoldsShow was written to prevent.
//
// So the exit condition is: the trigger alone is not sufficient — keep a grace, OR
// give isGhost a server-derived `now` (e.g. the Date header off a Supabase response,
// captured at fetch time and applied as a local offset), BEFORE narrowing the window
// back to 90s.
//
// What the grace COSTS, stated plainly because it is a real regression and not
// free: a main that is genuinely dead — the PA's battery dies mid-set — now reads
// as a calm grey "MAIN · <label>" for 3.5 minutes instead of 1.5. That is about
// one song during which the only cross-device signal that the desk running the
// show is gone says it is healthy, and the crew is looking at that badge precisely
// because they are trying to work out whether the silence is the PA or the room.
// Accepted because "ghost" never takes anything away by itself — the locked
// decision is เมนหาย = ไม่ auto-steal (docs/offline-first-plan.md §10.5) — so for
// those extra two minutes pressing เริ่มโชว์ elsewhere merely asks "โชว์กำลังรันอยู่
// บนเครื่อง X — ยืนยันไหม?" and then starts anyway when you confirm. Nobody is ever
// locked out. The other direction — a working PA declared dead in front of the
// crew mid-show, under a tooltip telling them to take control off it — is the
// failure being removed, and it is the worse of the two.
//
// ⚠️ THIS IS NOT THE LAST UNCORRECTED CROSS-DEVICE CLOCK COMPARISON. The round-10
// version of this comment claimed show_authority was "the one cross-device timing
// surface with no such correction". That was false, and it was false about the
// control path specifically, so it would have stopped the next reader from
// looking. The outstanding one is in components/event/live-mode.tsx's realtime-sync
// effect: it computes `skew = Date.now() - payload.sentAt`, applies it to the
// peer's claim for shouldMuteOnStepDown (`theirsAtMyClock: theirs + skew`) — and
// passes `theirs` RAW, straight off the peer's clock, into shouldYieldControl,
// which is the call that decides WHO DRIVES THE SHOW. With the same 2-minute-slow
// PA, pressing ขอควบคุม on the desk stamps a claim two minutes in the past, the
// phone's more-recent-claim-wins rule keeps control, and the PA both yields AND
// mutes itself — the operator presses "take control" on the desk with the speakers
// and the desk becomes a muted viewer. Fixing that lives in live-mode.tsx (pass
// `theirs + skew` into shouldYieldControl too, exactly as the shouldMuteOnStepDown
// call a few lines below it already does); this file does not certify it clean.
export const CLOCK_SKEW_GRACE_MS = 120_000;

/**
 * Has this claim gone quiet long enough to be treated as abandoned?
 *
 * The window is GHOST_MS + CLOCK_SKEW_GRACE_MS = 3.5 นาที for every caller — there
 * is no second, tighter path. See the long note above before changing either term
 * — and if you do change one, components/event/live-mode.tsx's otherDeviceHoldsShow()
 * comment quotes this SUM and has to move with it.
 *
 * @param now  our own clock (injectable for tests)
 */
export function isGhost(row: AuthorityRow, now: number = Date.now()): boolean {
  const t = new Date(row.heartbeat_at).getTime();
  return !Number.isFinite(t) || now - t > GHOST_MS + CLOCK_SKEW_GRACE_MS;
}

export interface ClaimInfo {
  deviceId: string;
  deviceLabel?: string | null;
  userId?: string | null;
  role?: Role | null;
}

/** Both authority rows for an event. Best-effort: [] on failure / offline. */
export async function getAuthority(eventId: string): Promise<AuthorityRow[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("show_authority")
      .select("*")
      .eq("event_id", eventId);
    if (error || !data) return [];
    return data as AuthorityRow[];
  } catch {
    return [];
  }
}

/** Claim (or hand-off-to-self / refresh) a role for this device — an upsert on
 *  (event_id, kind). Sets claimed_at + heartbeat_at. Returns whether it stuck. */
export async function claimAuthority(
  tenantId: string,
  eventId: string,
  kind: AuthorityKind,
  info: ClaimInfo
): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    const supabase = createClient();
    const { error } = await supabase.from("show_authority").upsert(
      {
        tenant_id: tenantId,
        event_id: eventId,
        kind,
        device_id: info.deviceId,
        device_label: info.deviceLabel ?? null,
        by_user_id: info.userId ?? null,
        by_role: info.role ?? null,
        claimed_at: now,
        heartbeat_at: now,
      },
      { onConflict: "event_id,kind" }
    );
    return !error;
  } catch {
    return false;
  }
}

/** Refresh the heartbeat for a role THIS device holds (no-op if it doesn't). */
export async function heartbeatAuthority(
  eventId: string,
  kind: AuthorityKind,
  deviceId: string
): Promise<void> {
  try {
    const supabase = createClient();
    await supabase
      .from("show_authority")
      .update({ heartbeat_at: new Date().toISOString() })
      .eq("event_id", eventId)
      .eq("kind", kind)
      .eq("device_id", deviceId);
  } catch {
    /* best-effort */
  }
}

/** Release a role THIS device holds (delete only if device_id matches mine, so it
 *  never clobbers a hand-off that already moved the row to another device). */
export async function releaseAuthority(
  eventId: string,
  kind: AuthorityKind,
  deviceId: string
): Promise<void> {
  try {
    const supabase = createClient();
    await supabase
      .from("show_authority")
      .delete()
      .eq("event_id", eventId)
      .eq("kind", kind)
      .eq("device_id", deviceId);
  } catch {
    /* best-effort */
  }
}
