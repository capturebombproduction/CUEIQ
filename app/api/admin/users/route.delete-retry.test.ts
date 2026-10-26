// 2026-10-27 hunt 3 (admin), a regression of 17b15ef: the cleanup after the soft delete ran
// its three deletes IN PARALLEL and answered "กดลบอีกครั้ง" when one failed. When the one
// that LANDED was tenant_members (group_roles or push_subscriptions failed), the retry met
// the isTenantMember gate with no row and answered 404 "ไม่พบผู้ใช้นี้ในค่ายของคุณ" - the
// advertised retry could never finish, the person was no longer listed, and the leftover
// band roles / push rows stayed for good. isTenantMember also ignored its own read error,
// so a DB hiccup gave that same 404 for someone who IS in the label.
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

import { DELETE, PATCH } from "@/app/api/admin/users/route";

beforeEach(() => {
  h.server = makeSupabaseFake({
    session: makeSession(),
    script: { tenant_members: ok([{ tenant_id: TENANT, role: "admin" }]) },
  });
});

/** The admin client over `db`, with an auth account that a first delete soft-deletes. */
function adminOver(db: SupabaseFake) {
  let deleted = false;
  return {
    from: db.from,
    rpc: db.rpc,
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
        getUserById: async () => ({
          data: {
            user: {
              id: TARGET,
              email: deleted ? "x@deleted" : "yuki@cueiq.local",
              deleted_at: deleted ? "2026-10-27T01:00:00Z" : null,
            },
          },
          error: null,
        }),
        deleteUser: async () => {
          if (deleted) return { data: {}, error: { message: "User not found", status: 404 } };
          deleted = true;
          return { data: {}, error: null };
        },
        updateUserById: async () => ({ data: {}, error: null }),
      },
    },
  };
}

const del = () => DELETE(new Request(`https://x/api/admin/users?user_id=${TARGET}`, { method: "DELETE" }));

describe("DELETE /api/admin/users - pressed again after a partial cleanup", () => {
  it.each(["group_roles", "push_subscriptions"])(
    "a failed %s delete keeps the membership, so the retry finishes the cleanup",
    async (failing) => {
      let memberRow = true;
      let blip = true;
      const db = makeSupabaseFake({
        script: {
          tenant_members: (c) => {
            if (c.verb === "select") return ok(memberRow ? [{ user_id: TARGET }] : []);
            if (c.verb === "delete") memberRow = false;
            return ok([]);
          },
          group_roles: ok([]),
          push_subscriptions: ok([]),
          [failing]: (c) =>
            c.verb === "delete" && blip ? fail("canceling statement due to statement timeout", 500) : ok([]),
        },
      });
      h.admin = adminOver(db);

      const first = await del();
      expect(first.status).toBe(500); // "ปิดบัญชีแล้ว … กดลบอีกครั้ง"
      expect(memberRow).toBe(true); // still listed, still reachable by the retry

      blip = false; // the admin presses delete again
      const second = await del();
      expect(second.status).toBe(200);
      expect(db.callsTo(failing, "delete")).toHaveLength(2);
      expect(memberRow).toBe(false);
    }
  );
});

describe("the tenant gate's own read failing", () => {
  const gateFails = () =>
    makeSupabaseFake({
      script: {
        tenant_members: (c) => (c.verb === "select" ? fail("TypeError: fetch failed", 500) : ok([])),
        group_roles: ok([]),
        push_subscriptions: ok([]),
      },
    });

  it("DELETE answers 'try again', not 'not in your label', and deletes nothing", async () => {
    const db = gateFails();
    h.admin = adminOver(db);
    const res = await del();
    expect(res.status).toBe(503);
    expect(await res.json()).not.toMatchObject({ error: "ไม่พบผู้ใช้นี้ในค่ายของคุณ" });
    expect(db.callsTo("group_roles", "delete")).toHaveLength(0);
  });

  it("PATCH answers 'try again', not 'not in your label'", async () => {
    h.admin = adminOver(gateFails());
    const res = await PATCH(
      new Request("https://x/api/admin/users", {
        method: "PATCH",
        body: JSON.stringify({ user_id: TARGET, password: "a-new-password" }),
      })
    );
    expect(res.status).toBe(503);
    expect(await res.json()).not.toMatchObject({ error: "ไม่พบผู้ใช้นี้ในค่ายของคุณ" });
  });
});
