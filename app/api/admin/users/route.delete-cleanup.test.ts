// 2026-10-27 hunt (admin), a regression of c4388cf: the account is SOFT-deleted now. A soft
// delete is an UPDATE of auth.users - nothing cascades any more - so the deletes after it
// (group_roles, tenant_members, push_subscriptions) are the ONLY thing taking the person
// out of the band audiences. Their errors were not read, push_subscriptions was not
// touched at all, and the route answered ok:true.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fail, makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const TENANT = "11111111-1111-4111-8111-111111111111";
const TARGET = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({ server: null as unknown, admin: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.server }));
vi.mock("@/lib/supabase/admin", () => ({
  hasServiceRole: () => true,
  createAdminClient: () => h.admin,
}));

import { DELETE } from "@/app/api/admin/users/route";

let db: SupabaseFake;

beforeEach(() => {
  h.server = makeSupabaseFake({
    session: makeSession(),
    script: { tenant_members: ok([{ tenant_id: TENANT, role: "admin" }]) },
  });
});

type AuthResult = { data: unknown; error: { message: string; status?: number } | null };
function adminWith(
  fake: SupabaseFake,
  over: { deleteUser?: () => Promise<AuthResult>; getUserById?: () => Promise<AuthResult> } = {}
) {
  return {
    from: fake.from,
    rpc: fake.rpc,
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
        getUserById:
          over.getUserById ??
          (async () => ({ data: { user: { id: TARGET, email: "seishin-mem@cueiq.local" } }, error: null })),
        deleteUser: vi.fn(over.deleteUser ?? (async () => ({ data: {}, error: null }))),
      },
    },
  };
}

const del = () => DELETE(new Request(`https://x/api/admin/users?user_id=${TARGET}`, { method: "DELETE" }));
const member = (c: { verb: string }) => (c.verb === "select" ? ok([{ user_id: TARGET }]) : ok([]));

describe("DELETE /api/admin/users after the soft delete", () => {
  it("a failed group_roles delete is not answered ok (the person stays in the band's reminders)", async () => {
    db = makeSupabaseFake({
      script: {
        tenant_members: member,
        group_roles: (c) =>
          c.verb === "delete" ? fail("canceling statement due to statement timeout", 500) : ok([]),
        push_subscriptions: ok([]),
      },
    });
    h.admin = adminWith(db);
    const res = await del();
    expect(db.callsTo("group_roles", "delete")).toHaveLength(1);
    expect(res.status).toBe(500);
  });

  it("a failed tenant_members delete is not answered ok (the row comes back in the console)", async () => {
    db = makeSupabaseFake({
      script: {
        tenant_members: (c) =>
          c.verb === "select" ? ok([{ user_id: TARGET }]) : c.verb === "delete" ? fail("timeout", 500) : ok([]),
        group_roles: ok([]),
        push_subscriptions: ok([]),
      },
    });
    h.admin = adminWith(db);
    expect((await del()).status).toBe(500);
  });

  it("the deleted person's push subscriptions go too (nothing cascades from a soft delete)", async () => {
    db = makeSupabaseFake({
      script: { tenant_members: member, group_roles: ok([]), push_subscriptions: ok([]) },
    });
    h.admin = adminWith(db);
    expect((await del()).status).toBe(200);
    const [push] = db.callsTo("push_subscriptions", "delete");
    expect(push?.eq).toMatchObject({ user_id: TARGET });
  });

  it("pressed again after a failed cleanup: the account is already deleted, the cleanup runs, ok", async () => {
    db = makeSupabaseFake({
      script: { tenant_members: member, group_roles: ok([]), push_subscriptions: ok([]) },
    });
    h.admin = adminWith(db, {
      deleteUser: async () => ({ data: {}, error: { message: "User not found", status: 404 } }),
      getUserById: async () => ({
        data: { user: { id: TARGET, email: "x@deleted", deleted_at: "2026-10-27T01:00:00Z" } },
        error: null,
      }),
    });
    expect((await del()).status).toBe(200);
    expect(db.callsTo("tenant_members", "delete")).toHaveLength(1);
  });

  it("a delete that fails on a LIVE account still fails, and strips nothing", async () => {
    db = makeSupabaseFake({
      script: { tenant_members: member, group_roles: ok([]), push_subscriptions: ok([]) },
    });
    h.admin = adminWith(db, {
      deleteUser: async () => ({ data: {}, error: { message: "Database error deleting user", status: 500 } }),
    });
    expect((await del()).status).toBe(400);
    expect(db.callsTo("tenant_members", "delete")).toHaveLength(0);
    expect(db.callsTo("group_roles", "delete")).toHaveLength(0);
  });
});
