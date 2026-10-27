// A login ID that is already taken (2026-10-27, hunt 7): POST handed GoTrue's English
// "A user with this email address has already been registered" straight to the console's
// toast while an admin was setting up a new band's accounts. It is now a 409 in Thai.
import { describe, it, expect, vi } from "vitest";
import { makeSession, makeSupabaseFake, ok } from "@/test/fakes/supabase";

const TENANT = "11111111-1111-4111-8111-111111111111";
const h = vi.hoisted(() => ({ server: null as unknown, admin: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.server }));
vi.mock("@/lib/supabase/admin", () => ({ hasServiceRole: () => true, createAdminClient: () => h.admin }));

import { POST } from "./route";

function post(loginId: string) {
  return POST(
    new Request("http://x/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ loginId, password: "12345678", tenantRole: "member", groupRoles: [] }),
    })
  );
}

function withCreateUser(error: { code?: string; status: number; message: string }) {
  h.server = makeSupabaseFake({
    session: makeSession(),
    script: { tenant_members: ok([{ tenant_id: TENANT, role: "admin" }]) },
  });
  const db = makeSupabaseFake({ script: { groups: ok([]) } });
  h.admin = {
    from: db.from,
    auth: {
      admin: {
        createUser: async () => ({ data: { user: null }, error: { name: "AuthApiError", ...error } }),
      },
    },
  };
}

describe("POST /api/admin/users · a taken login ID", () => {
  it("is a 409 that names the ID in Thai, not GoTrue's English", async () => {
    withCreateUser({
      code: "email_exists",
      status: 422,
      message: "A user with this email address has already been registered",
    });
    const res = await post("seishin1");
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.error).toBe('ชื่อผู้ใช้ "seishin1" มีอยู่แล้ว — ใช้ชื่ออื่น');
  });

  it("any other refusal keeps its own message", async () => {
    withCreateUser({ status: 400, message: "Password should be at least 8 characters" });
    const res = await post("seishin2");
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe("Password should be at least 8 characters");
  });
});
