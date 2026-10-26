// ---------------------------------------------------------------------------
// The admin gate, and what a role save answers with (2026-10-27, hunt 6).
//
// requireAdmin() dropped the error of its own membership read, so a timeout there told
// the label's real admin "ต้องเป็นแอดมินเท่านั้น" (403) on every console action - the
// misreport isTenantMember had just stopped making, one step earlier.
//
// And PATCH answered a bare { ok: true }: the console learned of its own save only
// through a follow-up GET, and when that failed it kept the old band roles on screen
// for the next save to send back. It now answers with what it STORED - the sanitised
// band roles, never the request's.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fail, makeSession, makeSupabaseFake, ok } from "@/test/fakes/supabase";

const TENANT = "11111111-1111-4111-8111-111111111111";
const BAND = "22222222-2222-4222-8222-222222222222";
const NOT_OURS = "33333333-3333-4333-8333-333333333333";
const TARGET = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({ server: null as unknown, admin: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.server }));
vi.mock("@/lib/supabase/admin", () => ({
  hasServiceRole: () => true,
  createAdminClient: () => h.admin,
}));

import { GET, PATCH } from "./route";

function adminClient(script: Parameters<typeof makeSupabaseFake>[0]) {
  const db = makeSupabaseFake(script);
  return {
    from: db.from,
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
        getUserById: async () => ({ data: { user: { id: TARGET, email: "band@cueiq.local" } }, error: null }),
        updateUserById: async () => ({ data: {}, error: null }),
      },
    },
  };
}

beforeEach(() => {
  h.server = makeSupabaseFake({
    session: makeSession(),
    script: { tenant_members: ok([{ tenant_id: TENANT, role: "admin" }]) },
  });
});

describe("admin gate", () => {
  it("a FAILED read of the caller's membership is a retryable 503, not 'not an admin'", async () => {
    h.server = makeSupabaseFake({
      session: makeSession(),
      script: { tenant_members: fail("canceling statement due to statement timeout", 500) },
    });
    h.admin = adminClient({ script: { tenant_members: ok([]), group_roles: ok([]) } });

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.error).not.toBe("ต้องเป็นแอดมินเท่านั้น");
  });

  it("a member who is not an admin is still refused (403)", async () => {
    h.server = makeSupabaseFake({
      session: makeSession(),
      script: { tenant_members: ok([{ tenant_id: TENANT, role: "member" }]) },
    });
    h.admin = adminClient({ script: {} });

    const res = await GET();

    expect(res.status).toBe(403);
  });
});

describe("PATCH answers with what it stored", () => {
  it("the sanitised band roles, not the request's", async () => {
    h.admin = adminClient({
      script: {
        tenant_members: ok([{ user_id: TARGET, tenant_id: TENANT, role: "member" }]),
        groups: ok([{ id: BAND }]),
        group_roles: (c) => (c.verb === "select" ? ok([{ group_id: BAND, role: "member" }]) : ok(null)),
      },
    });

    const res = await PATCH(
      new Request("http://x/api/admin/users", {
        method: "PATCH",
        body: JSON.stringify({
          user_id: TARGET,
          tenantRole: "member",
          groupRoles: [
            { group_id: BAND, role: "artist_manager" },
            { group_id: NOT_OURS, role: "member" }, // another label's band: dropped
            { group_id: BAND, role: "member" }, // a duplicate: dropped
          ],
        }),
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.user).toEqual({
      user_id: TARGET,
      tenantRole: "member",
      groupRoles: [{ group_id: BAND, role: "artist_manager" }],
    });
  });
});
