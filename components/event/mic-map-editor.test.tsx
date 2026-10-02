// CQ-06 (round 15). The MICS tab said "ยังไม่มีการกำหนดไมค์" on a show whose seven
// members all have standing mic numbers — while the Summary, the Lineup, the
// readiness gate and the Excel sheet all showed those same mics. The tab built its
// map only from the per-event mic_assignments the editor itself writes (zero rows
// on 40 of 41 production events, and on the real 10-03 show), and never used the
// members.mic_number fallback every other surface uses (decided rule: member mic
// numbers count). "No row" is not "no mics".
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { CompletenessResult } from "@/lib/completeness";
import type { EventRow, Group, Member, MicAssignment, SetlistItem } from "@/lib/types";

const router = vi.hoisted(() => ({
  push: () => {},
  refresh: () => {},
  replace: () => {},
  back: () => {},
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/events/e1",
  useSearchParams: () => new URLSearchParams(),
}));

import { MicMapEditor } from "@/components/event/mic-map-editor";
import { EventWorkspace } from "@/components/event/event-workspace";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { micBaseRows, performingMembers } from "@/lib/export-excel";

const EMPTY_TEXT = "ยังไม่มีการกำหนดไมค์";
const CAPTION = "ไมค์ประจำตัวสมาชิก (ยังไม่ได้ปรับเฉพาะงานนี้)";
const SONG_EMPTY = "ไม่มีการสลับไมค์รายเพลง — ใช้ไมค์ตาม Mic Map";

const member = (n: number, over: Partial<Member> = {}): Member => ({
  id: `m${n}`,
  tenant_id: "t1",
  group_id: "g1",
  name: `สมาชิก ${n}`,
  nickname: `นิค${n}`,
  mic_number: n,
  color: null,
  sort_order: n,
  created_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

const sevenMembers = () => [1, 2, 3, 4, 5, 6, 7].map((n) => member(n));

const assignment = (n: number, name: string): MicAssignment => ({
  id: `a${n}`,
  tenant_id: "t1",
  event_id: "e1",
  mic_number: n,
  holder_name: name,
  order_index: 1,
  created_at: "2026-01-01T00:00:00.000Z",
});

function mount(
  props: Partial<{
    editable: boolean;
    initialMics: MicAssignment[];
    members: Member[];
    lineup: string[];
    setlist: SetlistItem[];
  }> = {}
) {
  return render(
    <ConfirmProvider>
      <MicMapEditor
        eventId="e1"
        tenantId="t1"
        editable={props.editable ?? false}
        initialMics={props.initialMics ?? []}
        members={props.members ?? []}
        lineup={props.lineup ?? []}
        setlist={props.setlist ?? []}
      />
    </ConfirmProvider>
  );
}

const tiles = (container: HTMLElement) => Array.from(container.querySelectorAll(".mic"));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("MicMapEditor · members' standing mic numbers count", () => {
  it("shows seven tiles for seven members with mic numbers, and not the empty text", () => {
    const { container } = mount({ members: sevenMembers() });
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
    const t = tiles(container);
    expect(t).toHaveLength(7);
    // number over the member's display name, in mic order
    expect(t.map((el) => el.querySelector(".num")?.textContent)).toEqual([
      "1", "2", "3", "4", "5", "6", "7",
    ]);
    expect(within(t[2] as HTMLElement).getByText("นิค3")).toBeInTheDocument();
  });

  it("says plainly that these are the members' own mics, not set for this show", () => {
    mount({ members: sevenMembers() });
    expect(screen.getByText(CAPTION)).toBeInTheDocument();
  });

  it("only counts the people in this show's lineup", () => {
    const { container } = mount({ members: sevenMembers(), lineup: ["m2", "m5"] });
    expect(tiles(container).map((el) => el.querySelector(".num")?.textContent)).toEqual([
      "2",
      "5",
    ]);
  });

  it("caps each tile in the first holder's own colour", () => {
    const { container } = mount({
      members: [member(1, { color: "#A62A1C" }), member(2, { color: "#3366FF" })],
    });
    const caps = tiles(container).map((el) => el.querySelector("i")?.getAttribute("style"));
    expect(caps[0]).toContain("rgb(166, 42, 28)");
    expect(caps[1]).toContain("rgb(51, 102, 255)");
  });

  it("puts two members who share a mic on ONE tile", () => {
    const { container } = mount({
      members: [member(1), member(2, { mic_number: 1 }), member(3)],
    });
    const t = tiles(container);
    expect(t).toHaveLength(2);
    expect(t[0].textContent).toContain("นิค1");
    expect(t[0].textContent).toContain("นิค2");
  });

  it("an editor sees the same tiles and can still add a mic of their own", () => {
    const { container } = mount({ members: sevenMembers(), editable: true });
    expect(tiles(container)).toHaveLength(7);
    expect(screen.getByText(CAPTION)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
    expect(screen.getByRole("button", { name: /เพิ่มไมค์/ })).toBeInTheDocument();
  });

  it("says nothing is assigned only when the members have no mics either", () => {
    const { container } = mount({
      members: [1, 2, 3].map((n) => member(n, { mic_number: null })),
    });
    expect(screen.getByText(EMPTY_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(CAPTION)).toBeNull();
    expect(tiles(container)).toHaveLength(0);
  });

  it("with no members at all, still says so", () => {
    mount();
    expect(screen.getByText(EMPTY_TEXT)).toBeInTheDocument();
  });

  it("per-event assignments win: the fallback and its caption step aside", () => {
    const { container } = mount({
      members: sevenMembers(),
      initialMics: [assignment(1, "นิค1"), assignment(9, "แขกรับเชิญ")],
    });
    expect(screen.queryByText(CAPTION)).toBeNull();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
    // exactly this show's two mics, not the band's seven
    expect(tiles(container).map((el) => el.querySelector(".num")?.textContent)).toEqual([
      "1",
      "9",
    ]);
  });
});

// The tab re-states micBaseRows' fallback instead of importing it (export-excel
// pulls the whole xlsx library into this tab's chunk). These two keep the copy from
// drifting from the rule the Excel sheet prints.
describe("MicMapEditor · the same mics the Excel sheet prints", () => {
  const cases: [string, Member[], string[]][] = [
    ["the whole band", sevenMembers(), []],
    ["a chosen lineup", sevenMembers(), ["m6", "m1", "m4"]],
    [
      "a shared mic and members with no mic",
      [member(1), member(2, { mic_number: 1 }), member(3, { mic_number: null }), member(4, { mic_number: 9 })],
      [],
    ],
    ["a member with only a name", [member(1, { nickname: null }), member(2, { nickname: "  " })], []],
  ];

  it.each(cases)("%s", (_label, members, lineup) => {
    const { container } = mount({ members, lineup });
    const drawn = tiles(container).map((el) => [
      Number(el.querySelector(".num")?.textContent),
      el.querySelector(".truncate")?.textContent ?? "",
    ]);
    expect(drawn).toEqual(micBaseRows([], performingMembers(members, lineup)));
  });

  // The source check is the cheap half of the same guard: one import of
  // @/lib/export-excel and the Mics tab carries xlsx to every phone that opens it.
  it("does not import export-excel (and with it the xlsx library)", () => {
    const src = readFileSync(path.resolve(__dirname, "mic-map-editor.tsx"), "utf8");
    expect(src).not.toMatch(/from\s+["']@\/lib\/export-excel["']/);
  });
});

// A prop the workspace never passes is a fix that never runs: the tab must be handed
// the show's lineup, or a show with six of seven members would list the absent one.
describe("EventWorkspace · hands the Mics tab the lineup", () => {
  const group = { id: "g1", tenant_id: "t1", name: "วงทดสอบ" } as Group;
  const event = {
    id: "e1",
    tenant_id: "t1",
    group_id: "g1",
    name: "งานทดสอบ",
    event_date: "2026-12-01",
    event_type: "idol",
    status: "in_progress",
    is_template: false,
    group,
  } as unknown as EventRow & { group: Group | null };

  afterEach(() => {
    window.location.hash = "";
  });

  it("lists this show's performers' mics, not the whole band's", async () => {
    window.location.hash = "#mic";
    const { container } = render(
      <ConfirmProvider>
        <EventWorkspace
          event={event}
          eventId="e1"
          tenantId="t1"
          editable={false}
          completeness={{ complete: false, missing: [] } as unknown as CompletenessResult}
          eventType="idol"
          showStartTime={null}
          hardOutTime={null}
          schedule={[]}
          setlist={[]}
          micMap={[]}
          members={sevenMembers()}
          songs={[]}
          lineup={["m2", "m5"]}
        />
      </ConfirmProvider>
    );
    // the editor is code-split: wait for its chunk
    await screen.findByText(CAPTION);
    expect(tiles(container).map((el) => el.querySelector(".num")?.textContent)).toEqual([
      "2",
      "5",
    ]);
  });
});

describe("MicMapEditor · the per-song panel", () => {
  it("does not read as 'no mics' when no song swaps a mic", () => {
    mount({ members: sevenMembers() });
    expect(screen.getByText(SONG_EMPTY)).toBeInTheDocument();
  });
});
