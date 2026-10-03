// Live Mode's "what is THIS device" strip. The redesign hides it until something
// needs the operator — the status row already says whether this device drives. What
// the status row never says is WHICH device drives: 3ddf617's strip always carried
// "MAIN · iPad-xxxx" on a viewer, and with the strip hidden a healthy viewer had no
// way to know where control lives (whom to ask - there is no take-over).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { AuthorityRow } from "@/lib/show-authority";

const h = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/lib/show-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/show-authority")>()),
  getAuthority: vi.fn(async () => h.rows),
}));

vi.mock("@/lib/show-run-outbox", () => ({
  pendingCount: vi.fn(async () => 0),
  flushOutbox: vi.fn(async () => ({ flushed: 0, remaining: 0 })),
  SHOW_RUN_SAVE_EVENT: "cueiq:show-run-save",
}));

import { LiveStatusStrip } from "./live-status-strip";

const EVENT_ID = "ev-1";

function mainRow(over: Partial<AuthorityRow> = {}): AuthorityRow {
  const now = new Date().toISOString();
  return {
    event_id: EVENT_ID,
    kind: "show_main",
    device_id: "some-other-device-a1b2",
    device_label: "iPad หลังเวที",
    by_user_id: "u2",
    by_role: "admin",
    claimed_at: now,
    heartbeat_at: now,
    ...over,
  };
}

async function mount(props: { isController: boolean; soundOutput?: boolean }) {
  const view = render(
    <LiveStatusStrip eventId={EVENT_ID} isController={props.isController} soundOutput={props.soundOutput ?? true} />
  );
  // the authority read and the outbox count both land on a microtask
  await act(async () => {});
  await act(async () => {});
  return view.container.firstElementChild as HTMLElement;
}

beforeEach(() => {
  h.rows = [];
});

describe("LiveStatusStrip · where control lives", () => {
  it("a healthy viewer still sees which device holds MAIN — that chip alone", async () => {
    h.rows = [mainRow()];
    const strip = await mount({ isController: false });
    expect(strip).not.toHaveClass("hidden");
    const main = screen.getByText("MAIN · iPad หลังเวที");
    expect(main.closest(".chip")).not.toHaveClass("hidden");
    // the rest of the healthy strip stays out of the way, as the redesign intends
    for (const text of ["ดูอย่างเดียว", "เสียงออกเครื่องนี้", "ออนไลน์"]) {
      expect(screen.getByText(text, { exact: false }).closest(".chip"), text).toHaveClass("hidden");
    }
  });

  it("the controller itself, healthy, gets no strip at all", async () => {
    h.rows = [mainRow()];
    expect(await mount({ isController: true })).toHaveClass("hidden");
  });

  it("a viewer with no recorded MAIN has nothing to be told", async () => {
    expect(await mount({ isController: false })).toHaveClass("hidden");
  });

  it("a MAIN gone dark is a warning with the full strip, as before", async () => {
    h.rows = [mainRow({ heartbeat_at: new Date(Date.now() - 60 * 60_000).toISOString() })];
    const strip = await mount({ isController: false });
    expect(strip).not.toHaveClass("hidden");
    expect(screen.getByText("MAIN เดิมหลุด · iPad หลังเวที").closest(".chip")).toHaveClass("chip-warning");
    expect(screen.getByText("ออนไลน์").closest(".chip")).not.toHaveClass("hidden");
  });
});
