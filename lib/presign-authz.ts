// ---------------------------------------------------------------------------
// WHO MAY TOUCH WHICH OBJECT IN R2 — the whole decision, as a pure function.
//
// The presign route is the only door to the bucket, and until now its rule lived
// inline as a nested ternary that nothing could test: there is not one test for
// app/api/audio/presign/route.ts in the repo. Every other load-bearing rule in
// this codebase was moved out to a module for exactly that reason
// (lib/live-arbitration.ts, lib/completeness.ts, lib/dead-link.ts), and this one
// decides whether one band can fetch another band's masters and whether a member
// can read a colleague's screenshot. It belongs in the same place.
//
// The function never talks to Postgres. It returns a PLAN — either an answer it
// could reach from the key and the caller alone, or the exact SECURITY DEFINER
// predicate the route must ask under the caller's own session. The route executes
// the plan and nothing else.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A feedback attachment's file segment: a random token plus an image extension.
 *  A presigned PUT is signed on Bucket+Key only, so it will carry whatever bytes
 *  the holder sends — the extension is not proof of content. What it does buy is
 *  that the one route a plain band member can write through cannot be turned into
 *  a general file drop. */
export const FEEDBACK_IMAGE_FILE = /^[a-z0-9]{4,64}\.(png|jpe?g|webp|gif|heic)$/i;

export type PresignOp = "get" | "put" | "delete";

export type PresignPlan =
  /** Malformed key or op — answer 400 without looking at auth. */
  | { decision: "bad-key" }
  /** Settled from the key + caller alone; no round trip needed. */
  | { decision: "allow" }
  /** Settled from the key + caller alone; refuse. */
  | { decision: "deny" }
  /** Ask this predicate under the CALLER'S session, then allow iff it is true. */
  | { decision: "ask"; rpc: string; arg: Record<string, string> };

export function isPresignOp(op: unknown): op is PresignOp {
  return op === "get" || op === "put" || op === "delete";
}

/**
 * Key layouts in this bucket, and what authorizes each:
 *
 *   <tenant>/<band>/<event>/<item>-<rand>.<ext>   band audio    → can_view/edit_group
 *   <tenant>/<band>/songs/<song>-<rand>.<ext>     library audio → can_view/edit_group
 *   <tenant>/<event>/<item>                       LEGACY audio  → is_tenant_member /
 *                                                                 can_edit_tenant
 *   <tenant>/feedback/<author>/<rand>.<ext>       screenshots   → see below
 *   backups/…                                     DB snapshots  → never signed here
 *                                                                 ("backups" is not
 *                                                                 a UUID → bad-key)
 *
 * FEEDBACK ATTACHMENTS (migration 0043) are the one family that cannot ride the
 * rules above, and getting them wrong is wrong in BOTH directions:
 *
 *   • `can_edit_tenant` was re-scoped to admin-only in 0016, so the tenant-level
 *     fallback would refuse a screenshot to the plain band member the แจ้งปัญหา
 *     button exists for;
 *   • `is_tenant_member` on the read side would let all 19 accounts open each
 *     other's screenshots — broader than feedback_select, which reads
 *     `user_id = auth.uid() or can_admin_tenant(tenant_id)`.
 *
 * So the AUTHOR'S ID IS A SEGMENT OF THE KEY, and the rule lands on exactly what
 * that policy says about the row those bytes belong to:
 *
 *   put            → your own folder ONLY (an admin has no business writing under
 *                    someone else's name), and you must still be in that tenant;
 *   get / delete    → you, or an admin.
 */
export function planPresign(
  key: string,
  op: unknown,
  callerUserId: string
): PresignPlan {
  if (!key || key.startsWith("/") || key.includes("..") || !isPresignOp(op)) {
    return { decision: "bad-key" };
  }

  const segs = key.split("/");
  const tenantId = segs[0];
  if (!UUID.test(tenantId)) return { decision: "bad-key" };

  const isFeedback = segs.length === 4 && segs[1] === "feedback" && UUID.test(segs[2]);
  if (isFeedback) {
    if (!FEEDBACK_IMAGE_FILE.test(segs[3])) return { decision: "bad-key" };
    const author = segs[2];
    const ownFolder = author.toLowerCase() === callerUserId.toLowerCase();
    if (op === "put") {
      if (!ownFolder) return { decision: "deny" };
      // Still has to be a member of the tenant whose prefix is being written into,
      // or any signed-in account could park files under any tenant just by naming
      // it in the key.
      return { decision: "ask", rpc: "is_tenant_member", arg: { tid: tenantId } };
    }
    if (ownFolder) return { decision: "allow" };
    return { decision: "ask", rpc: "can_admin_tenant", arg: { tid: tenantId } };
  }

  // Band-scoped when segment 1 is a band id and the key has the 4-part shape;
  // otherwise the legacy tenant-level pair. Unchanged since before 0043.
  const groupId = segs.length >= 4 && UUID.test(segs[1]) ? segs[1] : null;
  if (groupId) {
    return {
      decision: "ask",
      rpc: op === "get" ? "can_view_group" : "can_edit_group",
      arg: { gid: groupId },
    };
  }
  return {
    decision: "ask",
    rpc: op === "get" ? "is_tenant_member" : "can_edit_tenant",
    arg: { tid: tenantId },
  };
}
