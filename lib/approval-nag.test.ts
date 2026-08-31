// The rule that decides whether an approval request gets a second reminder.
// Grounded in a real row: "Gorya seitan sai" sat at pending_review from
// 2026-07-15 for a 2026-07-19 show and was still there on 2026-08-31.
import { describe, it, expect } from "vitest";
import {
  APPROVAL_GRACE_DAYS,
  approvalNagBody,
  approvalsNeedingNag,
  daysWaiting,
  type ApprovalCandidate,
} from "@/lib/approval-nag";

const NOW = new Date("2026-07-18T01:00:00.000Z"); // the cron's hour, 08:00 Bangkok
const TODAY = "2026-07-18";

function row(over: Partial<ApprovalCandidate> = {}): ApprovalCandidate {
  return {
    id: "e1",
    status: "pending_review",
    event_date: "2026-07-19",
    updated_at: "2026-07-15T01:00:00.000Z", // exactly 3 days before NOW
    ...over,
  };
}

describe("approvalsNeedingNag", () => {
  it("reminds about a submission that has waited past the grace period", () => {
    expect(approvalsNeedingNag([row()], NOW, TODAY).map((r) => r.id)).toEqual(["e1"]);
  });

  it("stays quiet on the day it was submitted", () => {
    const fresh = row({ updated_at: "2026-07-18T00:30:00.000Z" });
    expect(approvalsNeedingNag([fresh], NOW, TODAY)).toEqual([]);
  });

  it("stays quiet one day short of the grace period, and speaks exactly on it", () => {
    // 86_400_000 ms per day, floored — so "2 days" means a full 48 hours.
    const justUnder = row({ updated_at: "2026-07-16T01:00:00.001Z" });
    const exactly = row({ updated_at: "2026-07-16T01:00:00.000Z" });
    expect(approvalsNeedingNag([justUnder], NOW, TODAY)).toEqual([]);
    expect(approvalsNeedingNag([exactly], NOW, TODAY)).toHaveLength(1);
  });

  it("still reminds on the day of the show — that is the last chance to answer", () => {
    expect(approvalsNeedingNag([row({ event_date: TODAY })], NOW, TODAY)).toHaveLength(1);
  });

  // THE POINT OF THE WHOLE RULE. "Gorya seitan sai" is real and it is still
  // pending_review today; a daily push about a show that happened in July is the
  // noise that teaches people to swipe reminders away, which would cost us the
  // ones that matter. It becomes a human's cleanup, once — not a standing alarm.
  it("goes SILENT once the show has happened, however long it has waited", () => {
    const gorya = row({
      event_date: "2026-07-19",
      updated_at: "2026-07-15T01:00:00.000Z",
    });
    const dayAfter = new Date("2026-07-20T01:00:00.000Z");
    expect(approvalsNeedingNag([gorya], dayAfter, "2026-07-20")).toEqual([]);
    // …and 6 weeks later, which is where that row actually is.
    const sixWeeks = new Date("2026-08-31T01:00:00.000Z");
    expect(approvalsNeedingNag([gorya], sixWeeks, "2026-08-31")).toEqual([]);
  });

  it.each(["draft", "in_progress", "approved", "rejected", "overdue"])(
    "ignores %s — nobody has asked for anything, or the answer is already given",
    (status) => {
      expect(approvalsNeedingNag([row({ status })], NOW, TODAY)).toEqual([]);
    }
  );

  it("ignores an undated event", () => {
    expect(approvalsNeedingNag([row({ event_date: null })], NOW, TODAY)).toEqual([]);
  });

  it("does not invent an overdue approval from a clock skewed into the future", () => {
    const skewed = row({ updated_at: "2026-07-25T01:00:00.000Z" });
    expect(daysWaiting(skewed, NOW)).toBe(0);
    expect(approvalsNeedingNag([skewed], NOW, TODAY)).toEqual([]);
  });

  it("survives an unparseable timestamp without nagging", () => {
    const junk = row({ updated_at: "not a date" });
    expect(daysWaiting(junk, NOW)).toBe(0);
    expect(approvalsNeedingNag([junk], NOW, TODAY)).toEqual([]);
  });

  it("keeps the grace period configurable and honours it", () => {
    expect(APPROVAL_GRACE_DAYS).toBe(2);
    expect(approvalsNeedingNag([row()], NOW, TODAY, 5)).toEqual([]);
    expect(approvalsNeedingNag([row()], NOW, TODAY, 3)).toHaveLength(1);
  });

  it("filters a mixed batch down to only the ones that qualify", () => {
    const rows = [
      row({ id: "waiting" }),
      row({ id: "past", event_date: "2026-07-01" }),
      row({ id: "fresh", updated_at: "2026-07-18T00:00:00.000Z" }),
      row({ id: "approved-already", status: "approved" }),
    ];
    expect(approvalsNeedingNag(rows, NOW, TODAY).map((r) => r.id)).toEqual(["waiting"]);
  });
});

describe("approvalNagBody", () => {
  it("says how long it has waited AND when the show is", () => {
    expect(approvalNagBody(row(), NOW, "Seishin Kakumei", "Gorya seitan sai")).toBe(
      "Gorya seitan sai · Seishin Kakumei — รออนุมัติมา 3 วัน · โชว์ 2026-07-19"
    );
  });

  it("drops the separator when the band name is unknown", () => {
    expect(approvalNagBody(row(), NOW, "", "Gorya seitan sai")).toBe(
      "Gorya seitan sai — รออนุมัติมา 3 วัน · โชว์ 2026-07-19"
    );
  });
});
