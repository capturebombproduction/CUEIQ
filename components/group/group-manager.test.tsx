// Artists (spec §G.9): a member who may only LOOK at their band's roster gets a
// roster — people, mic numbers, colours — not a wall of greyed-out form fields; their
// own band is the screen's one lit hero; and only an admin meets band-level controls.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { GroupManager } from "@/components/group/group-manager";
import { makePerms } from "@/lib/permissions";
import { bandTriplet } from "@/lib/band-triplet";
import { spotFor } from "@/lib/skin";
import type { Group, Member } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const T = "33333333-3333-4333-8333-333333333333";
const group = (id: string, name: string, color: string | null): Group => ({
  id,
  tenant_id: T,
  name,
  color,
  skin: null,
  exempt_from_deadline: false,
  self_photo: false,
  contact_name: null,
  contact_phone: null,
  created_at: "2026-01-01T00:00:00Z",
});
const HOSHI = group("g-hoshi", "Hoshizora Drops", "#3b82f6");
const SEISHIN = group("g-seishin", "Seishin Kakumei", "#A62A1C");

const member = (over: Partial<Member> & { id: string; group_id: string; name: string }): Member => ({
  tenant_id: T,
  nickname: null,
  mic_number: null,
  color: null,
  sort_order: 1,
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

const MEMBERS: Member[] = [
  member({ id: "m1", group_id: SEISHIN.id, name: "Yuki Tanaka", nickname: "ยูกิ", mic_number: 1, color: "#e11d48", sort_order: 1 }),
  member({ id: "m2", group_id: SEISHIN.id, name: "Riko", mic_number: null, sort_order: 2 }),
];

function mount(perms = makePerms("member", [{ group_id: SEISHIN.id, role: "member" }])) {
  return render(
    <ConfirmProvider>
      <GroupManager tenantId={T} initialGroups={[HOSHI, SEISHIN]} initialMembers={MEMBERS} perms={perms} />
    </ConfirmProvider>
  );
}

afterEach(() => cleanup());

describe("Artists for someone who can only look", () => {
  it("shows the roster as people — nickname, real name, mic — with no form fields", () => {
    mount();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);
    const roster = screen.getByRole("list", { name: "สมาชิก" });
    const yuki = within(roster).getByText("ยูกิ").closest("li")!;
    expect(yuki.textContent).toContain("Yuki Tanaka");
    expect(yuki.textContent).toMatch(/1/);
    expect(within(roster).getByText("Riko").closest("li")!.textContent).toContain("ไม่มีไมค์");
    // Nothing to add or delete from here.
    expect(screen.queryByRole("button", { name: /เพิ่มสมาชิก/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /ลบ/ })).toBeNull();
  });

  it("lights their own band as the hero, first, in that band's colour", () => {
    mount();
    const sections = screen.getAllByRole("region");
    expect(sections[0]).toHaveAccessibleName("Seishin Kakumei");
    expect(sections[0]).toHaveAttribute("data-band-hero", "true");
    expect(sections[0].className).toContain("lit");
    expect(sections[0].style.getPropertyValue("--lit")).toBe(bandTriplet(SEISHIN.color));
    // v3: its glow is that band's STAGE light, under the luminance ceiling — the raw
    // band colour (what --lit alone would glow in) is how SK Green lit a neon field.
    expect(sections[0].style.getPropertyValue("--lit-g")).toBe(spotFor(SEISHIN.color!).dark);
    expect(sections[0].style.getPropertyValue("--lit-g")).toBe("6 86% 50%");
    // Exactly one lit hero on the screen.
    expect(document.querySelectorAll(".lit")).toHaveLength(1);
  });
});

describe("Artists for an admin", () => {
  it("keeps the editable roster, and deleting a band is a dashed outline that says what it does", () => {
    mount(makePerms("admin"));
    expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0);
    const del = screen.getAllByRole("button", { name: /ลบวง/ })[0];
    expect(del).toHaveTextContent("ลบวง");
    expect(del.className).toContain("border-dashed");
    // An admin with no band of their own: no hero, every band reads the same.
    expect(document.querySelectorAll(".lit")).toHaveLength(0);
  });

  // CQ-36: `h-11 sm:h-9` used 640px as a stand-in for "has a mouse", so a touch iPad got
  // 36px skin buttons. The shrink keys on the pointer now. A class pin: jsdom has no
  // layout, the real size is the 768 hasTouch harness's to measure.
  it("the app-theme buttons are 44px for touch and shrink only for a fine pointer", () => {
    render(
      <ConfirmProvider>
        <GroupManager
          tenantId={T}
          initialGroups={[{ ...HOSHI, skin: "#3b82f6" }, SEISHIN]}
          initialMembers={MEMBERS}
          perms={makePerms("admin")}
        />
      </ConfirmProvider>
    );
    const off = screen.getByRole("button", { name: "ปิด" }); // the band that has a skin
    const on = screen.getByRole("button", { name: /ธีมแอปวง/ }); // the band that has none
    for (const b of [off, on]) {
      const c = b.className.split(/\s+/);
      expect(c).toContain("h-11");
      expect(c).toContain("[@media(pointer:fine)]:h-9");
      expect(c).not.toContain("sm:h-9");
    }
  });
});
