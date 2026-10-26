// The daily backup used to write its snapshot and then prune to the newest 30
// WHATEVER the snapshot contained. On a night when every table read fails (Supabase
// outage at 01:00, or a rotated / disabled service-role key - in which case
// reportCronFailure, riding the same dead key, cannot even log it) the job uploads a
// snapshot with `data: {}` and still deletes the oldest GOOD snapshot. That empty file
// is then backups[0]: the admin tile says "ทำงานปกติ · สำรองล่าสุด X ชม.ที่แล้ว" and
// "โหลดไฟล์สำรองล่าสุด" (download route: defaults to backups[0]) hands out the empty one.
// A month of such nights leaves no restorable snapshot at all.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  sent: [] as { name: string; input: Record<string, unknown> }[],
  existing: [] as string[],
}));

vi.mock("@/lib/supabase/admin", () => {
  // every table read fails, as with an invalid key / an outage
  const failing = () => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of ["select", "range", "order", "eq", "limit", "gt", "maybeSingle"]) b[m] = chain;
    (b as { then: unknown }).then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: { message: "Invalid API key" } }).then(res);
    return b;
  };
  return {
    hasServiceRole: () => true,
    createAdminClient: () => ({ from: () => failing() }),
  };
});

vi.mock("@/lib/r2", () => ({
  r2Configured: () => true,
  R2_BUCKET: "bucket",
  r2Client: () => ({
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      h.sent.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === "ListObjectsV2Command") {
        return { Contents: h.existing.map((Key) => ({ Key })) };
      }
      return {};
    },
  }),
}));

vi.mock("@/lib/cron-report", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, reportCronFailure: vi.fn(async () => {}) };
});

import { GET } from "@/app/api/cron/backup/route";

beforeEach(() => {
  h.sent.length = 0;
  // 30 good daily snapshots already in the bucket
  h.existing = Array.from({ length: 30 }, (_, i) =>
    `backups/cueiq-snapshot-2026-09-${String(i + 1).padStart(2, "0")}T18-00-00-000Z.json`
  );
  // the fresh one the job is about to write sorts last
  process.env.CRON_SECRET = "s3cret";
});

describe("a snapshot in which every table failed", () => {
  it("does not push a good snapshot out of the 30 kept", async () => {
    // the new key will be listed back by ListObjects too
    h.existing.push("backups/cueiq-snapshot-2026-10-26T18-00-00-000Z.json");
    const res = await GET(
      new Request("https://x/api/cron/backup", { headers: { authorization: "Bearer s3cret" } })
    );
    expect(res.status).toBe(500); // the job knows every table failed
    const del = h.sent.find((c) => c.name === "DeleteObjectsCommand");
    // the oldest GOOD snapshot is not deleted to make room for the empty one…
    expect(del).toBeUndefined();
    // …which goes to backups/partial/, where the admin download never offers it
    const put = h.sent.find((c) => c.name === "PutObjectCommand");
    expect(String(put?.input.Key).startsWith("backups/partial/cueiq-snapshot-")).toBe(true);
  });
});
