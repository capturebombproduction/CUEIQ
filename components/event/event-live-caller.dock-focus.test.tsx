import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { makeSupabaseFake, makeSession, ok, type SupabaseFake } from "@/test/fakes/supabase";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { AccountPanelProvider } from "@/components/account-panel";
import { EventLiveCaller, type RunSeqLive } from "./event-live-caller";

// 2026-10-30, hunt 12 (keys-5): a held Enter on a dock key is one press. Giving the key its focus back after
// a keyboard press was tried and taken out the same evening: the dead second Enter is what stops a fast
// double Enter walking the board two acts on an instant (offline) write, and "จบ + ต่อไป" has no undo.

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("@/lib/notify-client", () => ({ notify: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/events/ev-1/run-order/live",
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/run-order-outbox", async (orig) => ({
  ...(await orig<typeof import("@/lib/run-order-outbox")>()),
  listRunSeqOps: async () => [],
  enqueueRunSeq: async () => {},
}));

const row = (n: number): RunSeqLive => ({
  id: `r${n}`,
  sort_order: n,
  title: `act ${n}`,
  kind: "band",
  planned_start: `1${n}:00:00`,
  planned_end: `1${n + 1}:00:00`,
  buffer_seconds: 0,
  linked_event_id: `ev-${n}`,
  actual_start: null,
  actual_end: null,
  status: "pending",
  offset_min: null,
});
const ROWS = [1, 2, 3].map(row);

let supa: SupabaseFake;
let answer: (() => void) | null;
beforeEach(() => {
  supa = makeSupabaseFake({ session: makeSession() });
  h.supa = supa;
  answer = null;
  supa.setTable("run_sequence", (call) =>
    call.verb === "update"
      ? new Promise((resolve) => {
          answer = () => resolve(ok([{ id: call.eq.id }]));
        })
      : ok(ROWS)
  );
});
afterEach(() => vi.restoreAllMocks());

async function mount() {
  render(
    <AccountPanelProvider>
      <ConfirmProvider>
        <EventLiveCaller tenantId="t1" eventName="Fest" eventDate="2026-10-30" eventId="ev-1" initial={ROWS} canControl />
      </ConfirmProvider>
    </AccountPanelProvider>
  );
  await act(async () => {});
}
const startKey = () => screen.getByRole("button", { name: /^Start/ });

describe("Run board dock · the keyboard after a press", () => {
  it("the key stays disabled while the write is out (the double-press guard is untouched)", async () => {
    await mount();
    const key = startKey();
    await act(async () => {
      key.focus();
      fireEvent.click(key, { detail: 0 });
    });
    await waitFor(() => expect(answer).not.toBeNull());
    expect(key).toBeDisabled();
    await act(async () => {
      answer?.();
    });
  });

  it("a held Enter is one press: its repeats click nothing", async () => {
    await mount();
    const key = startKey();
    key.focus();
    const held = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", repeat: true, bubbles: true, cancelable: true });
    await act(async () => {
      key.dispatchEvent(held);
    });
    expect(held.defaultPrevented).toBe(true);
    const first = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      key.dispatchEvent(first);
    });
    expect(first.defaultPrevented).toBe(false);
  });
});
