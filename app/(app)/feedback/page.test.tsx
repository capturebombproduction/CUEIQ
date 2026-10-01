import { describe, it, expect, vi } from "vitest";
import { makePerms } from "@/lib/permissions";

// /feedback is where a "ทีมงานตอบฟีดแบคของคุณแล้ว" notification lands. Since the
// redesign (spec §G.9) it is also a place to WRITE one — through the very Feedback
// tile the More sheet carries, never a floating button. An async Server Component:
// it is called, and the returned tree is searched, not rendered.
const h = vi.hoisted(() => ({ ws: null as unknown }));
vi.mock("@/lib/queries", () => ({ getWorkspace: async () => h.ws }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/components/feedback-button", () => ({ FeedbackButton: () => null }));
vi.mock("@/components/my-feedback-list", () => ({ MyFeedbackList: () => null }));

import FeedbackPage from "@/app/(app)/feedback/page";
import { FeedbackButton } from "@/components/feedback-button";
import { MyFeedbackList } from "@/components/my-feedback-list";

interface Elementish {
  type?: unknown;
  props?: Record<string, unknown>;
}
function findEl(node: unknown, type: unknown): Elementish | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findEl(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const el = node as Elementish;
  if (el.type === type) return el;
  return el.props ? findEl(el.props.children, type) : null;
}

describe("FeedbackPage", () => {
  it("offers the report form for this account's label, beside the list of what was sent", async () => {
    h.ws = {
      user: { id: "u1", email: "seishin-mem@cueiq.local", name: "Mem" },
      membership: { tenant_id: "t1", role: "member" },
      tenant: { id: "t1", name: "A Lot Of Tone" },
      groups: [],
      groupRoles: [],
      perms: makePerms("member"),
    };
    const tree = await FeedbackPage();
    expect(findEl(tree, FeedbackButton)?.props).toMatchObject({ userId: "u1", tenantId: "t1" });
    expect(findEl(tree, MyFeedbackList)?.props).toMatchObject({ userId: "u1" });
  });
});
