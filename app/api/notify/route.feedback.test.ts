// feedback_replied after a SOFT delete (2026-10-27). Accounts are deleted softly since
// c4388cf, so feedback.user_id keeps a deleted author's id and the route's "author's
// account is gone" null check never fired: answering an old report from a deleted
// account pushed to that person's still-subscribed phone. The author must still be a
// member of the tenant (the delete removes the membership).
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  authorIsMember: true,
  inserted: [] as Row[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "caller" } } }) },
    rpc: async () => ({ data: true, error: null }),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  hasServiceRole: () => true,
  createAdminClient: () => ({ from: (t: string) => table(t) }),
}));
vi.mock("@/lib/push", () => ({ vapidConfigured: () => false, sendPush: vi.fn(async () => "ok") }));

function table(name: string) {
  const eqs: Record<string, unknown> = {};
  const q: Record<string, unknown> = {};
  for (const m of ["select", "gt", "is", "in", "order", "limit"]) q[m] = () => q;
  q.eq = (c: string, v: unknown) => {
    eqs[c] = v;
    return q;
  };
  q.maybeSingle = async () => {
    if (name === "feedback")
      return {
        data: { id: "fb-1", tenant_id: "t1", user_id: "author", reply: "แก้แล้วครับ", message: "ปุ่มกดไม่ได้" },
        error: null,
      };
    if (name === "tenant_members") {
      if (eqs.user_id === "caller") return { data: { user_id: "caller", role: "admin" }, error: null };
      if (eqs.user_id === "author") return { data: h.authorIsMember ? { user_id: "author" } : null, error: null };
    }
    return { data: null, error: null };
  };
  q.insert = async (rows: Row[]) => {
    if (name === "notifications") h.inserted.push(...rows);
    return { error: null };
  };
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return q;
}

import { POST } from "./route";

const reply = () =>
  POST(
    new Request("http://localhost/api/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "feedback_replied", feedbackId: "fb-1" }),
    })
  );

beforeEach(() => {
  h.authorIsMember = true;
  h.inserted = [];
});

describe("feedback_replied", () => {
  it("reaches the author who wrote it", async () => {
    const res = await reply();
    expect(res.status).toBe(200);
    expect(h.inserted.map((r) => r.user_id)).toEqual(["author"]);
  });

  it("a deleted author (no longer in the tenant) is told nothing", async () => {
    h.authorIsMember = false;
    const res = await reply();
    expect(res.status).toBe(200);
    expect(h.inserted).toEqual([]);
  });
});
