// setCopyrightStatus (2026-10-27, hunt 8): triage lands only on the song as the page
// showed it. A pending song whose FILE the Ar replaced since used to be cleared on the
// strength of the old recording - 0047's back-to-review only fires for a reviewed song.
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-session", () => ({ hasLiveSession: async () => true }));
import { friendlySongError, setCopyrightStatus } from "./copyright-triage";

function fake(write: { data: unknown[] | null; error: unknown }, row: Record<string, unknown> | null) {
  const eqs: [string, unknown][] = [];
  const client = {
    from: () => {
      let mode: "read" | "write" = "read";
      const b: Record<string, unknown> = {
        update: () => ((mode = "write"), b),
        eq: (c: string, v: unknown) => {
          if (mode === "write") eqs.push([c, v]);
          return b;
        },
        is: (c: string, v: unknown) => {
          if (mode === "write") eqs.push([c, v]);
          return b;
        },
        select: () => (mode === "write" ? Promise.resolve(write) : b),
        maybeSingle: () => Promise.resolve({ data: row, error: null }),
      };
      return b;
    },
  };
  return { client: client as never, eqs };
}

const SONG = {
  id: "s1",
  title: "Kakumei",
  copyright_status: "pending" as const,
  audio_path: "t/g/s1/old.wav" as string | null,
};

describe("setCopyrightStatus", () => {
  it("filters on the file the page has (and on no file)", async () => {
    const { client, eqs } = fake({ data: [{ id: "s1" }], error: null }, null);
    expect(await setCopyrightStatus(client, SONG, "cleared")).toEqual({ kind: "done" });
    expect(eqs).toContainEqual(["audio_path", "t/g/s1/old.wav"]);
    const none = fake({ data: [{ id: "s1" }], error: null }, null);
    await setCopyrightStatus(none.client, { ...SONG, audio_path: null }, "cleared");
    expect(none.eqs).toContainEqual(["audio_path", null]);
  });

  it("a file replaced since: nothing cleared, and the page is told the song changed", async () => {
    const { client } = fake(
      { data: [], error: null },
      { copyright_status: "pending", title: "Kakumei", audio_path: "t/g/s1/new.wav" }
    );
    const out = await setCopyrightStatus(client, SONG, "cleared");
    expect(out.kind).toBe("moved");
    if (out.kind === "moved") {
      expect(out.title).toBe("เพลงนี้ถูกแก้ไปแล้ว");
      expect(out.now.audio_path).toBe("t/g/s1/new.wav");
    }
  });

  it("an unchanged row that still took no write: the no-rows reason, not 'changed'", async () => {
    const { client } = fake(
      { data: [], error: null },
      { copyright_status: "pending", title: "Kakumei", audio_path: "t/g/s1/old.wav" }
    );
    expect((await setCopyrightStatus(client, SONG, "cleared")).kind).toBe("failed");
  });

  it("a 42501 is said in the user's terms", async () => {
    const { client } = fake(
      { data: null, error: { code: "42501", message: "new row violates row-level security policy" } },
      null
    );
    expect(await setCopyrightStatus(client, SONG, "rejected")).toMatchObject({
      kind: "failed",
      description: expect.stringMatching(/ไม่มีสิทธิ์บันทึก/),
    });
  });

  it("friendlySongError passes unknown text through", () => {
    expect(friendlySongError("boom")).toBe("boom");
    expect(friendlySongError(undefined)).toBeUndefined();
  });
});
