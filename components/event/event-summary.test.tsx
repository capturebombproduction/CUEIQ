// "รูปจากในแอฟมีการแสดงคนขาด แต่ตอนภาพสรุปไม่ได้แจ้งว่าครมาบ้างมีคนขาดไหม"
// (in-app feedback, 2026-09-11, from Seishin Kakumei's "A letter from the star",
// lineup 6 of 7). The summary drew the absentee on screen and then removed the
// whole members block while "บันทึกเป็นรูป (JPG)" ran, so the image — the sheet
// that actually gets passed around — said nothing about who was coming.
//
// What is asserted is the DOM at the instant html-to-image would read it, not
// the page at rest: the on-screen view was always right, which is how this
// shipped and stayed wrong for three months.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { EventRow, Group, Member } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const captured = vi.hoisted(() => ({ text: [] as string[] }));
vi.mock("@/lib/export-image", () => ({
  captureElementToImage: async (el: HTMLElement) => {
    captured.text.push(el.textContent ?? "");
    return "downloaded" as const;
  },
}));

import { EventSummary } from "./event-summary";

const group = { id: "g1", tenant_id: "t1", name: "วงทดสอบ" } as Group;

const event = {
  id: "e1",
  tenant_id: "t1",
  group_id: "g1",
  name: "งานทดสอบ",
  event_date: "2026-12-01",
  venue: null,
  show_start_time: null,
  hard_out_time: null,
  status: "draft",
  notes: null,
  map_url: null,
  costume_theme: null,
  is_template: false,
  group,
} as unknown as EventRow & { group: Group | null };

const member = (id: string, nickname: string, mic: number): Member =>
  ({ id, tenant_id: "t1", group_id: "g1", name: `${nickname} full`, nickname, mic_number: mic, color: null, sort_order: mic, created_at: "" }) as Member;

const members = [member("m1", "Aya", 1), member("m2", "Bell", 2), member("m3", "Cee", 3)];

async function exportImageText(lineup: string[]): Promise<string> {
  render(
    <EventSummary
      event={event}
      schedule={[]}
      setlist={[]}
      members={members}
      showMic={false}
      onNavigate={() => {}}
      lineup={lineup}
      tenantId="t1"
    />
  );
  fireEvent.click(screen.getByRole("button", { name: /บันทึกเป็นรูป/ }));
  await waitFor(() => expect(captured.text).toHaveLength(1));
  return captured.text[0];
}

describe("EventSummary — the JPG says who is coming", () => {
  beforeEach(() => {
    captured.text = [];
  });

  it("names the absent member in the image, not only on screen", async () => {
    const img = await exportImageText(["m1", "m3"]);
    expect(img).toContain("มางานนี้ 2/3 คน");
    expect(img).toContain("ขาด: Bell");
  });

  it("says the whole band is coming when nobody is missing", async () => {
    const img = await exportImageText(["m1", "m2", "m3"]);
    expect(img).toContain("มาครบทั้งวง 3 คน");
    expect(img).not.toContain("ขาด");
  });

  // Versions of a sheet pile up in the group chat; the image says when it was made.
  it("stamps the image with when it was exported — and only the image", async () => {
    const img = await exportImageText(["m1", "m2", "m3"]);
    expect(img).toContain("ส่งออกเมื่อ");
    expect(screen.queryByText(/ส่งออกเมื่อ/)).toBeNull(); // gone again on screen
  });

  it("an unchosen lineup is said out loud, never passed off as full attendance", async () => {
    const img = await exportImageText([]);
    expect(img).toContain("ยังไม่ได้เลือกรายชื่อคนมา");
    expect(img).not.toContain("มาครบ");
  });
});

// 2026-10-01: the summary is where every member lands. It used to greet them with
// "เข้า Live Mode" as its first, primary button (only an admin can drive Live
// Mode), a note telling them to edit via the tabs, and a "ไปแก้ไข:" bar of pencil
// buttons leading to fields that would not take a keystroke.
describe("EventSummary — speaks to what the reader can actually do", () => {
  const mountAs = (editable: boolean, canRunLive: boolean) =>
    render(
      <EventSummary
        event={event}
        schedule={[]}
        setlist={[]}
        members={members}
        showMic={false}
        onNavigate={() => {}}
        tenantId="t1"
        editable={editable}
        canRunLive={canRunLive}
      />
    );
  const liveLinks = () => screen.getAllByRole("link", { name: /Live Mode/ });

  it("a member: no edit bar, no 'edit via the tabs' note, Live Mode offered but not first", () => {
    mountAs(false, false);
    expect(screen.queryByText(/ไปแก้ไข/)).toBeNull();
    expect(screen.queryByText(/แก้ข้อมูลที่แท็บ/)).toBeNull();
    const links = liveLinks();
    expect(links).toHaveLength(1); // still one tap — anyone may run it to rehearse timing
    const bar = links[0].closest("div")!;
    const firstControl = bar.querySelector("a,button")!;
    expect(firstControl.textContent).not.toMatch(/Live Mode/); // not the lead action
  });

  it("an Ar (edits, cannot drive Live): keeps the edit bar", () => {
    mountAs(true, false);
    expect(screen.getByText(/ไปแก้ไข/)).toBeInTheDocument();
  });

  it("on the show's own day Live Mode leads for everyone", () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
    render(
      <EventSummary
        event={{ ...event, event_date: today }}
        schedule={[]}
        setlist={[]}
        members={members}
        showMic={false}
        onNavigate={() => {}}
        tenantId="t1"
        editable={false}
        canRunLive={false}
      />
    );
    const bar = liveLinks()[0].closest("div")!;
    expect(bar.querySelector("a,button")!.textContent).toMatch(/Live Mode/);
  });

  it("an admin: Live Mode leads, as before", () => {
    mountAs(true, true);
    const bar = liveLinks()[0].closest("div")!;
    expect(bar.querySelector("a,button")!.textContent).toMatch(/Live Mode/);
  });
});
