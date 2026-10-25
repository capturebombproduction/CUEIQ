// ---------------------------------------------------------------------------
// A FAILED staff_contacts READ IS NOT "ยังไม่มีทีมงาน".
//
// 2026-10-25 review: /crew coalesced a failed read to [] and rendered the manager with
// an empty crew - "ยังไม่มีทีมงาน — กด เพิ่มทีมงาน" - over a label's real crew, inviting
// staff to type them all in again (the desktop page was already fixed). Same rule as
// cdd7435 (lib/read-guard.ts): throw to the (app) error boundary, which retries.
// An async Server Component: it is called, and the returned tree is searched.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi } from "vitest";
import { fail, makeSession, makeSupabaseFake, ok } from "@/test/fakes/supabase";
import { makePerms } from "@/lib/permissions";

const h = vi.hoisted(() => ({ server: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.server }));
vi.mock("@/lib/queries", () => ({
  getWorkspace: async () => ({
    user: { id: "u1", email: "admin@cueiq.local", name: "Admin" },
    membership: { tenant_id: "t1", role: "admin" },
    tenant: { id: "t1", name: "A Lot Of Tone" },
    groups: [],
    groupRoles: [],
    perms: makePerms("admin"),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/components/page-title", () => ({ PageTitle: () => null }));

import CrewPage from "./page";
import { StaffContactsManager } from "@/components/admin/staff-contacts";

function findProps(node: unknown, type: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findProps(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type) return el.props ?? null;
  return el.props ? findProps(el.props.children, type) : null;
}

describe("/crew", () => {
  it("a failed staff_contacts read throws to the error boundary, never an empty crew", async () => {
    h.server = makeSupabaseFake({
      session: makeSession(),
      script: { staff_contacts: fail("canceling statement due to statement timeout", 500) },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(CrewPage()).rejects.toThrow();
  });

  it("a read that worked hands the manager the crew", async () => {
    const crew = [{ id: "c1", tenant_id: "t1", name: "พี่ช่างภาพ", sort_order: 0 }];
    h.server = makeSupabaseFake({ session: makeSession(), script: { staff_contacts: ok(crew) } });

    const props = findProps(await CrewPage(), StaffContactsManager);

    expect(props?.initial).toEqual(crew);
  });

  it("a crew that really is empty is still the empty state", async () => {
    h.server = makeSupabaseFake({ session: makeSession(), script: { staff_contacts: ok([]) } });

    const props = findProps(await CrewPage(), StaffContactsManager);

    expect(props?.initial).toEqual([]);
  });
});
