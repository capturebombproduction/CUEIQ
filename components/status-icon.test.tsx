import { render } from "@testing-library/react";
import { BookOpen, NotebookText, StickyNote, TriangleAlert } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  COPYRIGHT_META,
  PRACTICE_CATEGORY_META,
  STATUS_META,
  type CopyrightStatus,
  type GroupStatus,
  type MetaIconKey,
  type PracticeCategory,
} from "@/lib/types";
import { STATUS_CHIP } from "./status-badge";
import { META_ICONS, MetaIcon } from "./status-icon";

// Any pictographic emoji (✅ 🕒 ⛔ 📝 ⚠️ 📌 …) or the variation selector that turns a
// text glyph into one. Spec §0.3 rule 5: status is icon + word, never an emoji.
const EMOJI = /\p{Extended_Pictographic}|️/u;

const MAPS = {
  STATUS_META,
  COPYRIGHT_META,
  PRACTICE_CATEGORY_META,
} as Record<string, Record<string, { label: string; icon: MetaIconKey }>>;

const entries = Object.entries(MAPS).flatMap(([map, meta]) =>
  Object.entries(meta).map(([key, m]) => [`${map}.${key}`, m] as const)
);

describe("the *_META maps in lib/types.ts carry an icon key, not an emoji", () => {
  it.each(entries)("%s: a plain word and an icon key that resolves", (_, m) => {
    expect(m.label).not.toMatch(EMOJI);
    expect(m.label).toBe(m.label.trim());
    expect("emoji" in m, "the emoji field is gone — render <MetaIcon icon> instead").toBe(false);
    expect(Object.prototype.hasOwnProperty.call(META_ICONS, m.icon)).toBe(true);
  });

  // The words did not change when the emoji came off — only the glyph in front.
  it("keeps every human label exactly as it read before", () => {
    const labels = (meta: Record<string, { label: string }>) =>
      Object.fromEntries(Object.entries(meta).map(([k, m]) => [k, m.label]));
    expect(labels(COPYRIGHT_META)).toEqual({
      cleared: "ถูกต้อง",
      pending: "รอตรวจ",
      rejected: "ถูกปฏิเสธ",
    } satisfies Record<CopyrightStatus, string>);
    expect(labels(PRACTICE_CATEGORY_META)).toEqual({
      note: "บันทึก",
      problem: "ปัญหา",
      summary: "สรุป",
      homework: "การบ้าน",
    } satisfies Record<PracticeCategory, string>);
    expect(labels(STATUS_META)).toEqual({
      draft: "Draft",
      in_progress: "In Progress",
      pending_review: "Pending Review",
      approved: "Approved",
      rejected: "Rejected",
      overdue: "Overdue",
    } satisfies Record<GroupStatus, string>);
  });

  // StatusBadge owns the chip's icon (STATUS_CHIP). STATUS_META's key must name the
  // same one, or a menu row and the chip it opened from would disagree.
  it("STATUS_META names the same icon StatusBadge draws", () => {
    for (const s of Object.keys(STATUS_META) as GroupStatus[]) {
      expect(META_ICONS[STATUS_META[s].icon], s).toBe(STATUS_CHIP[s].Icon);
    }
  });

  // Rights are StatusChips (spec §G Library / Event): the same ladder as a show's status.
  it("a song's rights use the show-status ladder's icons", () => {
    expect(COPYRIGHT_META.cleared.icon).toBe(STATUS_META.approved.icon);
    expect(COPYRIGHT_META.pending.icon).toBe(STATUS_META.pending_review.icon);
    expect(COPYRIGHT_META.rejected.icon).toBe(STATUS_META.rejected.icon);
  });

  // Spec §G Training: summary NotebookText · homework BookOpen · problem TriangleAlert · note StickyNote.
  it("journal categories use the icons the spec names", () => {
    const icon = (c: PracticeCategory) => META_ICONS[PRACTICE_CATEGORY_META[c].icon];
    expect(icon("summary")).toBe(NotebookText);
    expect(icon("homework")).toBe(BookOpen);
    expect(icon("problem")).toBe(TriangleAlert);
    expect(icon("note")).toBe(StickyNote);
  });

  it("no two categories, and no two rights, share an icon", () => {
    const distinct = (meta: Record<string, { icon: MetaIconKey }>) =>
      new Set(Object.values(meta).map((m) => m.icon)).size === Object.keys(meta).length;
    expect(distinct(PRACTICE_CATEGORY_META)).toBe(true);
    expect(distinct(COPYRIGHT_META)).toBe(true);
  });
});

describe("MetaIcon", () => {
  it("draws the lucide icon a key names, hidden from screen readers (the word says it)", () => {
    const svg = render(<MetaIcon icon="hourglass" className="h-4 w-4" />).container.firstElementChild!;
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("class")).toContain("h-4");
    expect(svg.getAttribute("class")).toContain("lucide-hourglass");
  });

  // An offline cached row can lack the field the key came from; that must be a
  // missing glyph, never a crash in the middle of a list.
  it("draws nothing for a missing or unknown key", () => {
    expect(render(<MetaIcon icon={undefined} />).container.innerHTML).toBe("");
    expect(render(<MetaIcon icon={"rocket" as MetaIconKey} />).container.innerHTML).toBe("");
    expect(render(<MetaIcon icon={"constructor" as MetaIconKey} />).container.innerHTML).toBe("");
  });
});
