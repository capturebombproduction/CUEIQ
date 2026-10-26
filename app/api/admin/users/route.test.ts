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

import { DELETE, GET, PATCH } from "./route";

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

// ---------------------------------------------------------------------------
// A FAILED SAVE PUTS EVERYTHING BACK, OR SAYS IT COULD NOT.
//
// 2026-10-25 review: the restore insert after a failed band-role insert was never
// checked (a second timeout left the user with no band while the answer only showed
// the first error), and the tenant role was rewritten BEFORE the band-role replace and
// never put back - a CEO moved to a band role whose insert failed ended as an inert
// band-tier member with no band (locked out), from a save that "failed".
// ---------------------------------------------------------------------------
describe("PATCH /api/admin/users — a failed save leaves the user as they were", () => {
  function patch(body: unknown) {
    return PATCH(new Request("http://x/api/admin/users", { method: "PATCH", body: JSON.stringify(body) }));
  }

  /** tenant_members + group_roles that remember writes, so a test reads the end state. */
  function statefulDb(opts: {
    tenantRole: string;
    bands: { group_id: string; role: string }[];
    groupRoles?: (verb: string, values: unknown) => ReturnType<typeof ok> | null;
    tenantUpsert?: (n: number) => ReturnType<typeof ok> | null;
  }) {
    const state = { tenantRole: opts.tenantRole, bands: opts.bands.slice() };
    let upserts = 0;
    db = makeSupabaseFake({
      script: {
        tenant_members: (c) => {
          if (c.verb === "upsert") {
            const forced = opts.tenantUpsert?.(++upserts);
            if (forced) return forced;
            state.tenantRole = (c.values as { role: string }).role;
            return ok(null);
          }
          return ok([{ user_id: TARGET, tenant_id: TENANT, role: state.tenantRole }]);
        },
        groups: ok([{ id: BAND }, { id: OTHER_BAND }]),
        group_roles: (c) => {
          const forced = opts.groupRoles?.(c.verb, c.values);
          if (forced) return forced;
          if (c.verb === "select") return ok(state.bands.slice());
          if (c.verb === "delete") { state.bands = []; return ok(null); }
          if (c.verb === "insert") {
            state.bands.push(...(c.values as { group_id: string; role: string }[]).map((r) => ({ group_id: r.group_id, role: r.role })));
            return ok(null);
          }
          return ok(null);
        },
      },
    });
    h.admin = adminClient(db);
    return state;
  }

  it("a restore insert that also fails is said so (500), not hidden behind the first error", async () => {
    const state = statefulDb({
      tenantRole: "member",
      bands: [{ group_id: BAND, role: "artist_manager" }],
      groupRoles: (verb) => (verb === "insert" ? fail("canceling statement due to statement timeout", 500) : null),
    });

    const res = await patch({
      user_id: TARGET,
      tenantRole: "member",
      groupRoles: [{ group_id: BAND, role: "artist_manager" }, { group_id: OTHER_BAND, role: "member" }],
    });
    const json = await res.json();

    expect(state.bands).toEqual([]);
    expect(res.status).toBe(500);
    expect(json.error).not.toBe("canceling statement due to statement timeout");
    expect(json.error).toMatch(/วงเดิม/);
  });

  it("a band-role insert that fails puts the tenant role back too", async () => {
    const state = statefulDb({
      tenantRole: "ceo",
      bands: [],
      groupRoles: (verb) => (verb === "insert" ? fail("insert failed", 500) : null),
    });

    const res = await patch({ user_id: TARGET, tenantRole: "member", groupRoles: [{ group_id: BAND, role: "artist_manager" }] });

    expect(res.status).toBe(400);
    expect(state.tenantRole).toBe("ceo");
  });

  it("a band-role delete that fails puts the tenant role back", async () => {
    const state = statefulDb({
      tenantRole: "label_staff",
      bands: [],
      groupRoles: (verb) => (verb === "delete" ? fail("delete failed", 500) : null),
    });

    const res = await patch({ user_id: TARGET, tenantRole: "member", groupRoles: [{ group_id: BAND, role: "member" }] });

    expect(res.status).toBe(400);
    expect(state.tenantRole).toBe("label_staff");
  });

  it("a failed read of the old roles answers 503 BEFORE anything is written", async () => {
    const state = statefulDb({
      tenantRole: "admin",
      bands: [],
      groupRoles: (verb) => (verb === "select" ? fail("timeout", 500) : null),
    });

    const res = await patch({ user_id: TARGET, tenantRole: "member", groupRoles: [{ group_id: BAND, role: "member" }] });

    expect(res.status).toBe(503);
    expect(state.tenantRole).toBe("admin");
    expect(db.calls.filter((c) => c.verb !== "select")).toEqual([]);
  });

  it("a tenant-role restore that fails is said so (500)", async () => {
    const state = statefulDb({
      tenantRole: "ceo",
      bands: [],
      groupRoles: (verb) => (verb === "insert" ? fail("insert failed", 500) : null),
      tenantUpsert: (n) => (n === 2 ? fail("timeout", 500) : null),
    });

    const res = await patch({ user_id: TARGET, tenantRole: "member", groupRoles: [{ group_id: BAND, role: "artist_manager" }] });
    const json = await res.json();

    expect(state.tenantRole).toBe("member");
    expect(res.status).toBe(500);
    expect(json.error).toMatch(/สิทธิ์เดิม/);
  });
});

describe("DELETE /api/admin/users — an account that created events or sent feedback", () => {
  it("is SOFT-deleted: a hard delete's on-delete-set-null runs into the guard triggers", async () => {
    db = makeSupabaseFake({
      script: {
        tenant_members: ok([{ user_id: TARGET }]),
        group_roles: ok([]),
      },
    });
    const deleteUser = vi.fn(async () => ({ data: {}, error: null }));
    const client = adminClient(db);
    h.admin = { ...client, auth: { admin: { ...client.auth.admin, deleteUser } } };

    const res = await DELETE(new Request(`https://x/api/admin/users?user_id=${TARGET}`, { method: "DELETE" }));

    expect(res.status).toBe(200);
    expect(deleteUser).toHaveBeenCalledWith(TARGET, true);
    expect(db.callsTo("tenant_members", "delete")).toHaveLength(1);
  });
});
