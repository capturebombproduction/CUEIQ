// Client-side mirror of lib/queries.ts `getWorkspace` for the desktop SPA.
// The web version runs on the server (cookies + RSC); here we resolve the same
// data through the browser Supabase client (RLS applies identically via the
// user's session). Shape matches the web Workspace so reused components Just Work.
import { createClient } from "@/lib/supabase/client";
import { makePerms, type GroupRoleRow, type Perms } from "@/lib/permissions";
import type { Group, Role, Tenant } from "@/lib/types";
import { isOffline, readCache, writeCache } from "~/data/cache";
import { getStoredSessionUser } from "~/data/stored-session";

const WS_CACHE_KEY = "workspace";

/** How long the workspace load may wait on Supabase before serving the cache.
 *
 *  App.tsx bounds the equivalent getSession() at BOOT_SESSION_TIMEOUT_MS for one
 *  reason: a venue network that is JOINED but black-holed (navigator.onLine TRUE,
 *  TCP connects, nothing ever answers) leaves the request hanging with no timeout
 *  of its own. This module had the identical await and no bound — so the boot gate
 *  opened on time and the Shell then sat on "กำลังโหลด…" forever, one layer down,
 *  with the cached workspace, the cached events and every cached master sitting on
 *  disk unreachable. The ลองใหม่ button started the same unbounded wait again.
 *
 *  Two budgets, because they are different bets. Auth matches App.tsx's 5s. The
 *  table reads get longer: a working-but-slow hotspot should still deliver FRESH
 *  data rather than be written off as dead, and unlike auth they only run once
 *  auth has already answered. Worst case the Shell resolves in ~21s instead of
 *  never; anything that times out falls through to the owner-checked cache. */
export const WORKSPACE_AUTH_TIMEOUT_MS = 5000;
export const WORKSPACE_READ_TIMEOUT_MS = 8000;

/** Resolves to `null` if `p` has not settled within `ms`. The in-flight request is
 *  deliberately NOT cancelled — if it lands later it can still warm the cache for
 *  the next screen; we simply stop waiting on it. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    // Without this the pending timer keeps a handle alive for its full duration
    // after every fast, successful load.
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** The cached workspace, but only if it belongs to the account still persisted on
 *  this machine. The owner check is the shared-band-device privacy boundary: a
 *  different user signing in must never be shown the previous one's groups. */
function cachedForStoredUser(): WorkspaceData | null {
  const stored = getStoredSessionUser();
  if (!stored) return null;
  const cached = readCache<WorkspaceData>(WS_CACHE_KEY);
  return cached && cached.user?.id === stored.id ? cached : null;
}

export interface WorkspaceData {
  user: { id: string; email: string | null; name: string | null } | null;
  membership: { tenant_id: string; role: Role } | null;
  tenant: Tenant | null;
  groups: Group[];
  groupRoles: GroupRoleRow[];
  perms: Perms;
}

const empty = (
  user: WorkspaceData["user"]
): WorkspaceData => ({
  user,
  membership: null,
  tenant: null,
  groups: [],
  groupRoles: [],
  perms: makePerms(null),
});

export async function loadWorkspace(): Promise<WorkspaceData> {
  const supabase = createClient();

  // Offline: the table reads below all need the network, so serve the last good
  // workspace from cache instead — but only if a persisted session still exists
  // AND the cache belongs to that same user (sign-out wipes both — see App.tsx —
  // but a shared band device must never resurface another account's workspace).
  // Identity comes from the RAW stored session, NOT getSession(): with an expired
  // access token getSession() tries a network refresh and returns null offline
  // (the /login bounce this offline pass exists to prevent) — the stored session
  // survives network failures and only disappears on a real sign-out.
  if (isOffline()) {
    const cached = cachedForStoredUser();
    if (cached) return cached;
    const stored = getStoredSessionUser();
    return empty(stored ? { id: stored.id, email: stored.email, name: null } : null);
  }

  // Flaky network even though navigator says online (venue router, no internet):
  // auth-js resolves getUser() with `user: null` on a network failure rather than
  // rejecting, so treat null-user and rejection the SAME — fall back to the cache
  // under the stored-identity owner check (an instant storage read, no doomed
  // refresh attempt). A genuinely signed-out device has no stored session, so it
  // still lands on empty().
  // …and a request that NEVER answers is the same situation as one that fails, so
  // it takes the same branch. Unbounded, this is the hang described on
  // WORKSPACE_AUTH_TIMEOUT_MS above.
  const userResult = await withTimeout(
    supabase.auth.getUser().catch(() => null),
    WORKSPACE_AUTH_TIMEOUT_MS
  );
  const user = userResult?.data.user ?? null;
  if (!user) {
    const cached = cachedForStoredUser();
    if (cached) return cached;
    return empty(null);
  }

  const name =
    (user.user_metadata?.full_name as string | undefined) ?? user.email ?? null;
  const base = { id: user.id, email: user.email ?? null, name };

  // Both key on user.id alone — one round trip instead of two (mirrors
  // lib/queries.ts getWorkspace).
  // Same bound as auth, longer budget: a batch that never answers must not park the
  // Shell on its spinner. A timeout reads as "no membership + an errored group_roles
  // read", which is exactly what the two branches below already handle correctly.
  const firstBatch = await withTimeout(
    Promise.all([
      supabase
        .from("tenant_members")
        .select("tenant_id, role")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabase.from("group_roles").select("group_id, role").eq("user_id", user.id),
    ]),
    WORKSPACE_READ_TIMEOUT_MS
  );
  const memberRow = firstBatch?.[0]?.data ?? null;
  const groupRolesRes = firstBatch?.[1] ?? { data: null, error: new Error("timed out") };

  if (!memberRow) {
    // No membership found — but a transient network blip can also yield null.
    // If we have a cached workspace for this same user, trust it over an empty.
    const cached = readCache<WorkspaceData>(WS_CACHE_KEY);
    if (cached && cached.user?.id === user.id && cached.membership) return cached;
    return empty(base);
  }

  const role = memberRow.role as Role;

  const secondBatch = await withTimeout(
    Promise.all([
      supabase
        .from("tenants")
        .select("*")
        .eq("id", memberRow.tenant_id)
        .maybeSingle(),
      supabase
        .from("groups")
        .select("*")
        .eq("tenant_id", memberRow.tenant_id)
        .order("created_at", { ascending: true }),
    ]),
    WORKSPACE_READ_TIMEOUT_MS
  );
  // A timeout is a blip, not an empty tenant with no groups — `blipped` below is
  // what stops a half-empty result from overwriting a good cache.
  const tenantRes = secondBatch?.[0] ?? { data: null, error: new Error("timed out") };
  const groupsRes = secondBatch?.[1] ?? { data: null, error: new Error("timed out") };
  const tenant = tenantRes.data;

  // membership read succeeded but the parallel batch blipped — either no tenant
  // came back, or a groups/group_roles read errored (postgrest resolves network
  // failures as { data: null, error }, so an errored read must not become empty
  // groups/groupRoles). Don't clobber a good cache with this half-empty result.
  const blipped = Boolean(tenantRes.error || groupsRes.error || groupRolesRes.error);
  if (!tenant || blipped) {
    const cached = readCache<WorkspaceData>(WS_CACHE_KEY);
    if (cached && cached.user?.id === user.id && cached.membership) return cached;
  }

  const groupRoles = (groupRolesRes.data ?? []) as GroupRoleRow[];

  const ws: WorkspaceData = {
    user: base,
    membership: { tenant_id: memberRow.tenant_id as string, role },
    tenant: (tenant as Tenant) ?? null,
    groups: (groupsRes.data ?? []) as Group[],
    groupRoles,
    perms: makePerms(role, groupRoles),
  };
  // Cache only a COMPLETE read: a tenant-less or errored result here means the
  // parallel batch blipped (and there was no cache to fall back on) — don't make
  // it the offline copy.
  if (ws.tenant && !blipped) writeCache(WS_CACHE_KEY, ws);
  return ws;
}
