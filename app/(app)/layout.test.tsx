// The authenticated web shell (FINAL-SPEC-v2 §F.4). Its element tree is read
// directly — the components it mounts have their own tests; what is pinned HERE is
// the wiring, because a shell that forgets to mount something fails silently:
//  · NO floating แจ้งปัญหา button (product decision, round 2) — reporting is the
//    Feedback tile in the More sheet;
//  · the tab bar, the account panel and ONE unread count above all three readers;
//  · the header and the push nudge step aside on the immersive Live screens;
//  · a failed `groups` read does not take the whole shell down with it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { makePerms } from "@/lib/permissions";

const h = vi.hoisted(() => ({ ws: null as unknown }));
vi.mock("@/lib/queries", () => ({ getWorkspace: async () => h.ws }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  usePathname: () => "/dashboard",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

import AppLayout from "@/app/(app)/layout";
import { FeedbackButton, FeedbackUnreadProvider } from "@/components/feedback-button";
import { AccountPanel, AccountPanelProvider } from "@/components/account-panel";
import { TabBar } from "@/components/tab-bar";
import { ChromeGate } from "@/components/chrome-gate";
import { AppMain } from "@/components/app-main";
import { SiteHeader } from "@/components/site-header";
import { PushNudge } from "@/components/notifications/push-nudge";
import { FRAME_LIGHT_AIM, StageLight } from "@/components/stage-light";

type El = ReactElement<Record<string, unknown>>;

/** Every element in the tree, with its chain of ancestors — through `children`
 *  AND any other prop that holds elements. */
function walk(node: unknown, ancestors: El[] = [], out: { el: El; up: El[] }[] = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, ancestors, out));
  } else if (isValidElement(node)) {
    const el = node as El;
    out.push({ el, up: ancestors });
    for (const v of Object.values(el.props ?? {})) walk(v, [...ancestors, el], out);
  }
  return out;
}

const SEISHIN = { id: "g1", name: "Seishin Kakumei" };

function workspace(groups: () => unknown = () => [SEISHIN]) {
  const ws = {
    user: { id: "u1", email: "seishin-mem@cueiq.local", name: "มายด์" },
    membership: { tenant_id: "t1", role: "member" },
    tenant: { id: "t1", name: "A Lot Of Tone" },
    groupRoles: [{ group_id: "g1", role: "member" }],
    perms: makePerms("member", [{ group_id: "g1", role: "member" } as never]),
  };
  Object.defineProperty(ws, "groups", { get: groups, enumerable: true });
  return ws;
}

const tree = async () => walk(await AppLayout({ children: <div data-testid="page" /> }));
const find = (all: { el: El; up: El[] }[], type: unknown) => all.filter((n) => n.el.type === type);

beforeEach(() => {
  h.ws = workspace();
});

describe("(app) layout — no floating feedback button", () => {
  it("mounts no FeedbackButton of its own: reporting is the More sheet's tile", async () => {
    const all = await tree();
    expect(find(all, FeedbackButton)).toHaveLength(0);
    expect(all.some((n) => "floating" in (n.el.props ?? {}))).toBe(false);
  });
});

describe("(app) layout — the shell's parts", () => {
  it("mounts the tab bar and the account panel once each, under ONE unread count", async () => {
    const all = await tree();
    const tab = find(all, TabBar);
    const panel = find(all, AccountPanel);
    expect(tab).toHaveLength(1);
    expect(panel).toHaveLength(1);
    expect(find(all, FeedbackUnreadProvider)).toHaveLength(1);
    for (const n of [...tab, ...panel, ...find(all, SiteHeader)]) {
      expect(n.up.some((a) => a.type === FeedbackUnreadProvider)).toBe(true);
      expect(n.up.some((a) => a.type === AccountPanelProvider)).toBe(true);
    }
    expect(find(all, FeedbackUnreadProvider)[0].el.props.userId).toBe("u1");
  });

  it("gates the header and the push nudge off the immersive Live screens — never the panel", async () => {
    const all = await tree();
    for (const type of [SiteHeader, PushNudge]) {
      const [n] = find(all, type);
      expect(n.up.at(-1)?.type).toBe(ChromeGate);
    }
    // The panel also carries the installed-app fullscreen nudge, which must be able
    // to appear on any page, Live included.
    expect(find(all, AccountPanel)[0].up.some((a) => a.type === ChromeGate)).toBe(false);
  });

  it("pads <main> clear of the tab bar and clips sideways without breaking sticky", async () => {
    const all = await tree();
    // <main> is rendered by AppMain (a client component: the immersive screens drop
    // this padding, and only the client knows the path — components/app-main.test.tsx).
    const main = all.find((n) => n.el.type === AppMain)!.el;
    const cls = String(main.props.className).split(/\s+/);
    expect(cls).toContain("pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+24px)]");
    expect(cls).toContain("overflow-x-clip");
    expect(cls).not.toContain("overflow-hidden");
    const frame = all.find(
      (n) => n.el.type === "div" && String(n.el.props.className).includes("isolate")
    )!.el;
    const frameCls = String(frame.props.className).split(/\s+/);
    expect(frameCls).toContain("bg-background");
    expect(frameCls).not.toContain("bg-muted/30");
    expect(frameCls).toContain("lg:[--tabbar-h:0px]");
  });
});

/** A class that would turn a `position: fixed` descendant into "absolute to this
 *  box" (it would scroll away and end in a seam), or make it a containing block. */
const TRAPS_FIXED = /(^|\s)(?:[\w-]+:)*(?:transform|transform-gpu|-?translate-|-?scale-|-?rotate-|-?skew-|blur|backdrop-|filter|drop-shadow|will-change-transform|contain-|perspective)/;

describe("(app) layout — the page light (v3 Stage Wash, §E.11 / §F.4)", () => {
  it("mounts ONE StageLight as the frame's first child, gated off the immersive screens", async () => {
    const all = await tree();
    const lights = find(all, StageLight);
    expect(lights).toHaveLength(1);
    const [light] = lights;
    // Live Mode and the live show-caller mount their own (aimed at the NOW column,
    // and inside the root that .zone-over sits on) — one per document.
    expect(light.up.at(-1)?.type).toBe(ChromeGate);
    const frame = light.up.at(-2)!;
    expect(String(frame.props.className).split(/\s+/)).toEqual(expect.arrayContaining(["relative", "isolate"]));
    const first = ([] as unknown[]).concat(frame.props.children).find(isValidElement) as El;
    expect(first.type).toBe(ChromeGate);
    expect(first.props.children).toBe(light.el);
  });

  // From lg up a page title sits at the container's LEFT edge; a light hung at 50 %
  // put its hot core in the empty middle of the row and its throw as a pale stripe
  // down the middle of the light theme. The aim is set on the FRAME, so the light and
  // the Event page's sticky .lit-bar (which repeats it) can never disagree.
  it("aims the light at the left-aligned title from lg up, from the frame", async () => {
    const [light] = find(await tree(), StageLight);
    const frame = light.up.at(-2)!;
    const cls = String(frame.props.className).split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(FRAME_LIGHT_AIM.split(" ")));
    expect(cls).toContain("lg:[--spot-x:25%]");
    // a page that is one centred column keeps it centred on that column
    expect(cls).toContain("lg:[&:has([data-stage-centred])]:[--spot-x:50%]");
    // and the element itself states no aim, so it inherits the frame's
    expect(light.el.props.className).toBeUndefined();
    expect(light.el.props.x).toBeUndefined();
  });

  it("nothing between it and the viewport traps `position: fixed`", async () => {
    const [light] = find(await tree(), StageLight);
    const traps = light.up
      .filter((a) => typeof a.type === "string")
      .map((a) => String(a.props.className ?? ""))
      .filter((c) => TRAPS_FIXED.test(c));
    expect(traps).toEqual([]);
    for (const a of light.up) expect((a.props.style as Record<string, unknown> | undefined)?.transform).toBeUndefined();
  });
});

describe("(app) layout — the account line", () => {
  it("names the band", async () => {
    const [panel] = find(await tree(), AccountPanel);
    expect(panel.el.props.line).toBe("สมาชิก · Seishin Kakumei");
  });

  it("a failed groups read leaves the band name off — it does not take the shell down", async () => {
    h.ws = workspace(() => {
      throw new Error("groups read failed");
    });
    const [panel] = find(await tree(), AccountPanel);
    expect(panel.el.props.line).toBe("สมาชิก");
  });
});
