import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 2026-10-19: deleting Seishin's practice room took 104 runs, its journal and its
// attendance with it - 0024 made every practice table's event_id NOT NULL + ON DELETE
// CASCADE. 0051 keeps what the band did and wrote (runs, journal) and drops only what
// IS the room (its song list, its check-in strip). Read the migrations in order and
// pin the delete rule each one ends on, so a later migration cannot put the cascade
// back without this failing.

const dir = path.resolve(__dirname, "../supabase/migrations");

/** The `on delete …` the migrations last gave <table>.event_id, plus whether it is still NOT NULL. */
function eventIdRule(table: string): { onDelete: string; notNull: boolean } {
  let onDelete = "";
  let notNull = false;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8").replace(/--.*$/gm, "");
    const create = new RegExp(
      `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
      "i"
    ).exec(sql);
    const col = create && /\n\s*event_id\s+uuid([^\n]*)/i.exec(create[1]);
    if (col) {
      notNull = /not\s+null/i.test(col[1]);
      onDelete = /on\s+delete\s+(cascade|set\s+null|restrict|no\s+action)/i.exec(col[1])?.[1] ?? "no action";
    }
    if (new RegExp(`alter\\s+table\\s+public\\.${table}\\s+alter\\s+column\\s+event_id\\s+drop\\s+not\\s+null`, "i").test(sql)) {
      notNull = false;
    }
    const fk = new RegExp(
      `alter\\s+table\\s+public\\.${table}\\s+add\\s+constraint\\s+\\w+\\s+foreign\\s+key\\s*\\(event_id\\)[^;]*?on\\s+delete\\s+(cascade|set\\s+null|restrict|no\\s+action)`,
      "i"
    ).exec(sql);
    if (fk) onDelete = fk[1];
  }
  return { onDelete: onDelete.toLowerCase().replace(/\s+/g, " "), notNull };
}

describe("a practice room's delete keeps the band's history (0051)", () => {
  it.each(["practice_runs", "practice_logs"])("%s.event_id is nullable and SET NULL", (t) => {
    expect(eventIdRule(t)).toEqual({ onDelete: "set null", notNull: false });
  });

  it.each(["practice_songs", "practice_attendance"])("%s still goes with its room", (t) => {
    expect(eventIdRule(t)).toEqual({ onDelete: "cascade", notNull: true });
  });
});
