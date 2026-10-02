import { describe, it, expect, vi } from "vitest";
import { makePerms } from "@/lib/permissions";

// /admin's Inbox tile is an in-page link (#dev-inbox). app/globals.css puts a
// scroll-padding-top on <html> that already clears the fixed header (+ the offline
// strip, + the notch), so the anchor must NOT add a header-sized scroll-margin of
// its own on top: the two stack, and the jump landed ~60px below where it should.
// An async Server Component: it is called, and the returned tree is searched.
const h = vi.hoisted(() => ({ ws: null as unknown }));
vi.mock("@/lib/queries", () => ({ getWorkspace: async () => h.ws }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
// No service role -> the Users card shows its "set the key" notice and feedbackNames()
// returns {} without touching a client.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("createAdminClient should not be reached without a service role");
  },
  hasServiceRole: () => false,
}));
vi.mock("@/lib/r2", () => ({ getR2Usage: async () => null, listBackups: async () => [] }));
vi.mock("@/components/admin/user-manager", () => ({ UserManager: () => null }));
vi.mock("@/components/admin/dev-inbox", () => ({ DevInbox: () => null }));
vi.mock("@/components/admin/storage-usage", () => ({ StorageUsage: () => null }));
vi.mock("@/components/admin/backup-status", () => ({ BackupStatus: () => null }));
vi.mock("@/components/page-title", () => ({ PageTitle: () => null }));

import AdminPage from "@/app/(app)/admin/page";

interface Elementish {
  type?: unknown;
  props?: Record<string, unknown>;
}
function findById(node: unknown, id: string): Elementish | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findById(child, id);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const el = node as Elementish;
  if (el.props?.id === id) return el;
  return el.props ? findById(el.props.children, id) : null;
}

describe("AdminPage — the #dev-inbox anchor", () => {
  it("leaves the header clearance to the html scroll-padding: a short scroll-mt, no second header-sized one", async () => {
    h.ws = {
      user: { id: "u1", email: "admin@cueiq.local", name: "Admin" },
      membership: { tenant_id: "t1", role: "admin" },
      tenant: { id: "t1", name: "A Lot Of Tone" },
      groups: [],
      groupRoles: [],
      perms: makePerms("admin"),
    };
    const tree = await AdminPage();
    const section = findById(tree, "dev-inbox");
    expect(section).not.toBeNull();
    const cls = String(section?.props?.className ?? "").split(/\s+/);
    expect(cls).toContain("scroll-mt-2");
    // Nothing that reads the header token / the notch and so doubles the html rule.
    expect(cls.filter((c) => c.startsWith("scroll-mt-") && c !== "scroll-mt-2")).toEqual([]);
  });
});
