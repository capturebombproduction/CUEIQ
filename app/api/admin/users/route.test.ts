// ---------------------------------------------------------------------------
// A FAILED READ OF THE BAND ROLES IS NOT "THIS USER HAS NO BANDS".
//
// 2026-10-24 review (Argon, verified): GET read tenant_members and group_roles and
// coalesced a failed read to [] - so one hiccup on group_roles answered 200 with every
// user band-less, the admin console took that list, and the next "save" on a user (whose
// dialog now opened with no bands ticked) replaced their real band roles with nothing.
// And PATCH replaced the roles delete-then-insert: an insert that failed left the user
// with no band at all. The label onboards every account through this console.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fail, makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const TENANT = "11111111-1111-4111-8111-111111111111";
const BAND = "22222222-2222-4222-8222-222222222222";
const OTHER_BAND = "33333333-3333-4333-8333-333333333333";
const TARGET = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({ server: null as unknown, admin: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.server }));
vi.mock("@/lib/supabase/admin", () => ({
  hasServiceRole: () => true,
  createAdminClient: () => h.admin,
}));

import { GET, PATCH } from "./route";

let server: SupabaseFake;
let db: SupabaseFake;

function adminClient(fake: SupabaseFake) {
  return {
    from: fake.from,
    rpc: fake.rpc,
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
  const session = makeSession();
  server = makeSupabaseFake({
    session,
    script: { tenant_members: ok([{ tenant_id: TENANT, role: "admin" }]) },
  });
  h.server = server;
});

describe("GET /api/admin/users", () => {
  it("a failed read of the band roles is an error, never a list of band-less users", async () => {
    db = makeSupabaseFake({
      script: {
        tenant_members: ok([{ user_id: TARGET, role: "member" }]),
        group_roles: fail("canceling statement due to statement timeout", 500),
        profiles: ok([{ id: TARGET, email: "band@cueiq.local", full_name: "Band" }]),
      },
    });
    h.admin = adminClient(db);

    const res = await GET();

    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe("PATCH /api/admin/users — replacing a user's band roles", () => {
  it("an insert that fails puts the roles they had back", async () => {
    const before = [{ group_id: BAND, role: "member" }];
    db = makeSupabaseFake({
      script: {
        tenant_members: ok([{ user_id: TARGET, tenant_id: TENANT, role: "member" }]),
        groups: ok([{ id: BAND }, { id: OTHER_BAND }]),
        group_roles: (call) =>
          call.verb === "select"
            ? ok(before)
            : call.verb === "insert" && (call.values as { group_id: string }[])[0]?.group_id === OTHER_BAND
              ? fail("insert failed", 500)
              : ok([]),
        profiles: ok([{ id: TARGET, email: "band@cueiq.local" }]),
      },
    });
    h.admin = adminClient(db);

    const res = await PATCH(
      new Request("http://x/api/admin/users", {
        method: "PATCH",
        body: JSON.stringify({
          user_id: TARGET,
          tenantRole: "member",
          groupRoles: [{ group_id: OTHER_BAND, role: "member" }],
        }),
      })
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    const inserts = db.calls.filter((c) => c.table === "group_roles" && c.verb === "insert");
    // the new set failed, then the old one went back in
    expect(inserts.at(-1)?.values).toEqual([
      { tenant_id: TENANT, group_id: BAND, user_id: TARGET, role: "member" },
    ]);
  });
});
