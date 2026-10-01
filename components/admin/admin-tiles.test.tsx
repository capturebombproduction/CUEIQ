// Admin's control-centre tiles (spec §G.8): the backup and the storage say how they
// are with a chip — an icon and a word — and the storage fill is a real meter, so
// neither state is carried by colour alone.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BackupStatus } from "@/components/admin/backup-status";
import { StorageUsage } from "@/components/admin/storage-usage";
import type { BackupObject } from "@/lib/r2";

afterEach(() => cleanup());

const backup = (hoursAgo: number): BackupObject => ({
  key: "backups/cueiq.json.gz",
  size: 1_840_000,
  lastModified: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
});

/** The tile's status chip: an svg icon AND the word. */
function chip(word: string) {
  const el = screen.getByText(word, { selector: ".chip" });
  expect(el.querySelector("svg")).not.toBeNull();
  return el;
}

describe("the Backup tile", () => {
  it("says a fresh backup is running normally", () => {
    render(<BackupStatus backups={[backup(3)]} />);
    expect(chip("ทำงานปกติ").className).toContain("chip-success");
    expect(screen.getByRole("link", { name: /โหลดไฟล์สำรองล่าสุด/ })).toHaveAttribute(
      "href",
      "/api/admin/backup/download"
    );
  });

  it("says a backup older than 26 hours has a gap", () => {
    render(<BackupStatus backups={[backup(30)]} />);
    expect(chip("ขาดช่วง").className).toContain("chip-warning");
  });

  it("says when there is no backup yet", () => {
    render(<BackupStatus backups={[]} />);
    expect(chip("ยังไม่มีไฟล์").className).toContain("chip-neutral");
  });
});

describe("the Storage tile", () => {
  it("is a meter of the free 10 GB, and says it is nearly full past 90%", () => {
    render(<StorageUsage bytes={9.5 * 1024 ** 3} count={300} />);
    const meter = screen.getByRole("meter", { name: "พื้นที่ที่ใช้ไป" });
    expect(meter).toHaveAttribute("aria-valuenow", "95");
    expect(chip("ใกล้เต็ม").className).toContain("chip-danger");
  });

  it("says there is room below 75%", () => {
    render(<StorageUsage bytes={1.2 * 1024 ** 3} count={42} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "12");
    expect(chip("เหลือพอ").className).toContain("chip-success");
  });
});
