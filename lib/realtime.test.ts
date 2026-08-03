import { describe, expect, it } from "vitest";
import { liveTopic, runOrderTopic, songsTopic } from "@/lib/realtime";

// 0040_realtime_authorization.sql authorizes a private channel by PARSING the
// topic string: split_part(topic, ':', 1) is the kind and split_part(topic, ':', 2)
// must be the uuid it checks permission on. If a topic here ever stops matching
// that shape the policy denies it, and the symptom is a show that silently stops
// syncing between devices — so pin the contract from this side too.
const KIND = (t: string) => t.split(":")[0];
const REF = (t: string) => t.split(":")[1];

const EVENT = "abbd645c-927c-456c-8a55-1971e197e361";
const GROUP = "c8788874-d6f9-41bd-a675-5d7628a15881";
const TENANT = "00000000-0000-0000-0000-000000000001";

describe("realtime topics ↔ can_use_realtime_topic()", () => {
  it("live:<eventId>", () => {
    expect(KIND(liveTopic(EVENT))).toBe("live");
    expect(REF(liveTopic(EVENT))).toBe(EVENT);
  });

  it("songs:<groupId>", () => {
    expect(KIND(songsTopic(GROUP))).toBe("songs");
    expect(REF(songsTopic(GROUP))).toBe(GROUP);
  });

  it("runorder:<tenantId>:…", () => {
    const t = runOrderTopic(TENANT, "2026-08-09", "La famiglia");
    expect(KIND(t)).toBe("runorder");
    expect(REF(t)).toBe(TENANT);
  });

  // The whole reason the tenant sits at position 2 and the name last: an event
  // name is free text. A raw ':' in it would shift every later field and the
  // policy would read the wrong uuid — or none.
  it("an event name full of colons cannot shift the tenant out of position 2", () => {
    const t = runOrderTopic(TENANT, "2026-08-09", "A: B: C");
    expect(REF(t)).toBe(TENANT);
    expect(t).not.toContain("A: B");
    expect(decodeURIComponent(t.split(":").slice(3).join(":"))).toBe("A: B: C");
  });

  it("a dateless event still keeps the tenant in position 2", () => {
    expect(REF(runOrderTopic(TENANT, null, "No date"))).toBe(TENANT);
  });

  // The builder, the caller board and the per-band status card must all land on
  // ONE topic or they stop hearing each other.
  it("is a pure function of its inputs", () => {
    expect(runOrderTopic(TENANT, "2026-08-09", "Fest")).toBe(
      runOrderTopic(TENANT, "2026-08-09", "Fest")
    );
  });
});
