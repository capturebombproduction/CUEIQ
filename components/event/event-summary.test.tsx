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
import type { EventRow, Group, Member, SetlistItem } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const captured = vi.hoisted(() => ({
  text: [] as string[],
  // The classes the sheet wears at the instant html-to-image reads it.
  classes: [] as { grid: string; tile: string; title: string }[],
}));
vi.mock("@/lib/export-image", () => ({
  captureElementToImage: async (el: HTMLElement) => {
    captured.text.push(el.textContent ?? "");
    // the "ขึ้นเวที" tile of the four-times grid (the label also appears in the table)
    const well = Array.from(el.querySelectorAll(".well")).find(
      (w) => w.firstElementChild?.textContent === "ขึ้นเวที"
    );
    captured.classes.push({
      grid: well?.parentElement?.className ?? "",
      tile: well?.children[1]?.className ?? "",
      title:
        Array.from(el.querySelectorAll("span")).find((s) => s.textContent === "เพลง 1")
          ?.className ?? "",
    });
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

// "เกิน Hard Out" is the overtime alarm — and the run sheet painted it, and every
// row past the hard out, in --destructive. lib/skin.ts moves that token OFF red for
// a band whose own colour is red (so an error never reads as the band), which made
// Seishin Kakumei's overtime violet. Overtime is the band-independent alarm plate,
// identical for every band (spec §0.3 rule 4), on screen and on the exported sheet.
describe("EventSummary — past the hard out is the alarm, never the band's destructive", () => {
  const item = (id: string, sort_order: number, seconds: number) =>
    ({
      id,
      tenant_id: "t1",
      event_id: "e1",
      kind: "song",
      title: `เพลง ${sort_order}`,
      duration_seconds: seconds,
      buffer_before_seconds: 0,
      buffer_after_seconds: 0,
      mic_slots: [],
      notes: null,
      sort_order,
    }) as SetlistItem;

  it("the badge and the late rows use the alarm tone", () => {
    const { container } = render(
      <EventSummary
        event={{ ...event, show_start_time: "18:00:00", hard_out_time: "18:05:00" }}
        schedule={[]}
        setlist={[item("a", 1, 240), item("b", 2, 240)]}
        members={[]}
        showMic={false}
        onNavigate={() => {}}
        tenantId="t1"
      />
    );
    const badge = screen.getByText(/เกิน Hard Out \+3:00/).closest(".chip")!;
    expect(badge.className.split(" ")).toContain("chip-alarm");
    expect(badge.querySelector("svg")).not.toBeNull(); // icon + word
    const late = container.querySelectorAll("tr[data-over-hard-out]");
    expect(late).toHaveLength(1); // 18:04–18:08 runs past 18:05; the first song does not
    // nothing on the sheet reaches for the band-skinned destructive token
    expect(container.querySelector('[class*="destructive"], .chip-danger')).toBeNull();
  });
});

// The event page's hero carries Live Mode (EventHero), so the summary's bar is left
// with the run sheet's own actions — offering Live twice on one screen read as two
// different things.
describe("EventSummary — Live Mode when the hero already has it", () => {
  it("leaves the bar to the JPG and print", () => {
    render(
      <EventSummary
        event={event}
        schedule={[]}
        setlist={[]}
        members={members}
        showMic={false}
        onNavigate={() => {}}
        tenantId="t1"
        canRunLive
        showLive={false}
      />
    );
    expect(screen.queryByRole("link", { name: /Live Mode/ })).toBeNull();
    expect(screen.getByRole("button", { name: /บันทึกเป็นรูป/ })).toBeInTheDocument();
  });
});

// 2026-10-02 (CQ-07): the exported sheet is a fixed 600 px wide, but its Tailwind
// breakpoints (sm:) read the SENDER'S window, not the node. A sheet exported from a
// phone came out 2 x 2 with 20 px values and 12 px song titles; the same sheet from
// a laptop came out 4 across with 26 px values and 14 px titles. Same show, two
// different images in the group chat. While capturing, the sheet wears the sm+ look.
describe("EventSummary — the JPG looks the same whichever screen sent it", () => {
  const song = {
    id: "s1",
    tenant_id: "t1",
    event_id: "e1",
    kind: "song",
    title: "เพลง 1",
    duration_seconds: 240,
    buffer_before_seconds: 0,
    buffer_after_seconds: 0,
    mic_slots: [],
    notes: null,
    sort_order: 1,
  } as SetlistItem;

  const mount = () =>
    render(
      <EventSummary
        event={{ ...event, show_start_time: "18:00:00" }}
        schedule={[]}
        setlist={[song]}
        members={members}
        showMic={false}
        onNavigate={() => {}}
        tenantId="t1"
      />
    );

  beforeEach(() => {
    captured.classes = [];
  });

  it("captures the four-across tiles with the 26 px values, not the phone's 2 x 2", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /บันทึกเป็นรูป/ }));
    await waitFor(() => expect(captured.classes).toHaveLength(1));
    const { grid, tile } = captured.classes[0];
    expect(grid.split(" ")).toContain("grid-cols-4");
    expect(grid.split(" ")).not.toContain("grid-cols-2");
    expect(tile.split(" ")).toContain("text-[26px]");
    expect(tile.split(" ")).not.toContain("text-[20px]");
  });

  it("captures the song titles at 14 px, not the phone's 12 px", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /บันทึกเป็นรูป/ }));
    await waitFor(() => expect(captured.classes).toHaveLength(1));
    const title = captured.classes[0].title.split(" ");
    expect(title).toContain("text-sm");
    expect(title).not.toContain("text-xs");
  });

  it("on screen the responsive classes are untouched", () => {
    const { container } = mount();
    const well = Array.from(container.querySelectorAll(".well")).find(
      (w) => w.firstElementChild?.textContent === "ขึ้นเวที"
    )!;
    expect(well.parentElement!.className.split(" ")).toEqual(
      expect.arrayContaining(["grid-cols-2", "sm:grid-cols-4"])
    );
    expect(well.children[1].className).toContain("text-[20px]");
    expect(well.children[1].className).toContain("sm:text-[26px]");
    expect(screen.getByText("เพลง 1").className).toBe("text-xs sm:text-sm");
  });
});
