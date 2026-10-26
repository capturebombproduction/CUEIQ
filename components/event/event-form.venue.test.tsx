// The event form's venue field fills the map link from a venue preset. It used to
// match the FIRST key of any venue ("T" is inside "Lot of Live (Bangkok)"), and
// every later key left the filled link alone - shows at other venues saved Lot of
// Live's Google Map.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { EventForm } from "@/components/event/event-form";

const LOT_MAP = "https://maps.app.goo.gl/DHPdAWzxqi7XLFdm7";

function renderForm(event?: Record<string, unknown>) {
  render(
    <ConfirmProvider>
      <EventForm
        mode={event ? "edit" : "create"}
        tenantId="t1"
        userId="u1"
        groups={[{ id: "g1", name: "Seishin" } as never]}
        defaultGroupId="g1"
        event={event as never}
      />
    </ConfirmProvider>
  );
  return {
    venue: screen.getByLabelText("สถานที่") as HTMLInputElement,
    map: screen.getByLabelText("Google Map (ลิงก์)") as HTMLInputElement,
  };
}

function typeKeyByKey(input: HTMLInputElement, text: string) {
  for (let i = 1; i <= text.length; i++) {
    fireEvent.change(input, { target: { value: text.slice(0, i) } });
  }
}

describe("EventForm venue → map link", () => {
  it("typing another venue key by key leaves the map link empty", () => {
    const { venue, map } = renderForm();
    typeKeyByKey(venue, "The Street Ratchada");
    expect(venue.value).toBe("The Street Ratchada");
    expect(map.value).toBe("");
  });

  it("typing Lot of Live fills its link", () => {
    const { venue, map } = renderForm();
    typeKeyByKey(venue, "Lot of Live");
    expect(map.value).toBe(LOT_MAP);
  });

  it("a filled link goes away when the venue stops being the preset", () => {
    const { venue, map } = renderForm();
    typeKeyByKey(venue, "Lot o");
    expect(map.value).toBe(LOT_MAP);
    typeKeyByKey(venue, "Lot Fusion");
    expect(map.value).toBe("");
  });

  it("a link the user pasted is never replaced or cleared", () => {
    const { venue, map } = renderForm();
    fireEvent.change(map, { target: { value: "https://maps.app.goo.gl/mine" } });
    typeKeyByKey(venue, "Lot of Live");
    expect(map.value).toBe("https://maps.app.goo.gl/mine");
    fireEvent.change(venue, { target: { value: "Elsewhere" } });
    expect(map.value).toBe("https://maps.app.goo.gl/mine");
  });

  it("moving a saved Lot of Live show to another venue drops Lot of Live's map", () => {
    const { venue, map } = renderForm({
      id: "e1",
      group_id: "g1",
      event_name: "Show",
      event_date: "2026-11-01",
      venue: "Lot of Live (Bangkok)",
      map_url: LOT_MAP,
      status: "draft",
    });
    expect(map.value).toBe(LOT_MAP);
    fireEvent.change(venue, { target: { value: "The Street Ratchada" } });
    expect(map.value).toBe("");
  });
});
