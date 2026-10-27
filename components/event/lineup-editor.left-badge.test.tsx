// 2026-10-27, hunt 8: a member who left the band (0054) stays on a lineup that holds them -
// on purpose, a band may keep a leaver for a farewell show - and on shows dated before they
// left. The Lineup tab drew them exactly like everyone else, so a show still to come kept a
// leaver nobody noticed until show day. They now carry an "ออกจากวงแล้ว" chip.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { makeSession, makeSupabaseFake } from "@/test/fakes/supabase";
import type { Member } from "@/lib/types";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { LineupEditor } from "./lineup-editor";

const member = (n: number, left_at: string | null = null): Member => ({
  id: `m${n}`,
  tenant_id: "t1",
  group_id: "g1",
  name: `สมาชิก ${n}`,
  nickname: `นิค${n}`,
  mic_number: n,
  color: null,
  sort_order: n,
  created_at: "2026-01-01T00:00:00.000Z",
  left_at,
});

afterEach(() => cleanup());

describe("LineupEditor: a member who has left the band", () => {
  it("is marked ออกจากวงแล้ว; the others are not", () => {
    h.supa = makeSupabaseFake({ session: makeSession() });
    render(
      <ConfirmProvider>
        <LineupEditor
          eventId="e1"
          tenantId="t1"
          editable
          members={[member(1), member(2, "2026-10-27T03:00:00Z")]}
          initialLineup={["m1", "m2"]}
        />
      </ConfirmProvider>
    );
    const left = screen.getByRole("button", { name: /นิค2/ });
    expect(within(left).getByText("ออกจากวงแล้ว")).toBeTruthy();
    const stays = screen.getByRole("button", { name: /นิค1/ });
    expect(within(stays).queryByText("ออกจากวงแล้ว")).toBeNull();
  });
});
