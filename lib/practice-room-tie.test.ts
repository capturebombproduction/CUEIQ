import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 0052 (2026-10-24), measured on a PGlite copy of prod's guards + policies: a member could
// write a practice row "of their own band" into another band's room (holding that band's
// song slot, invisible to it), a room that moved band left every row behind, and an Ar's
// crafted PATCH could rewrite a show's run time. The fixes are triggers and guard
// functions, so pin what the LAST migration to touch each one leaves - a later
// `create or replace` that drops a check, or a `drop trigger`, fails here.

const dir = path.resolve(__dirname, "../supabase/migrations");
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/--.*$/gm, ""));

/** The body of the last `create or replace function public.<name>` across the migrations. */
function lastFunction(name: string): string {
  let body = "";
  for (const sql of files) {
    const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(([\\s\\S]*?)\\$\\$;`, "gi");
    for (const m of sql.matchAll(re)) body = m[1].replace(/\s+/g, " ").toLowerCase();
  }
  return body;
}

/** Is <trigger> on <table> still created by the migrations, and never dropped after? */
function triggerLives(trigger: string, table: string, timing: RegExp): boolean {
  let alive = false;
  for (const sql of files) {
    const s = sql.replace(/\s+/g, " ").toLowerCase();
    const create = new RegExp(`create trigger ${trigger} ([^;]*?) on public\\.${table} `).exec(s);
    if (create) alive = timing.test(create[1]);
    else if (new RegExp(`drop trigger (if exists )?${trigger} on public\\.${table}`).test(s)) alive = false;
  }
  return alive;
}

describe("a practice row lives in its own band's room (0052)", () => {
  it.each(["practice_songs", "practice_logs", "practice_attendance", "practice_runs"])(
    "%s checks every insert and update",
    (t) => {
      expect(triggerLives(`${t}_in_its_room`, t, /^before insert or update$/)).toBe(true);
    }
  );

  it("the check ties room, band and tenant, and a new row needs a practice room", () => {
    const fn = lastFunction("practice_row_in_its_room");
    expect(fn).toContain("e.group_id = new.group_id");
    expect(fn).toContain("e.tenant_id = new.tenant_id");
    expect(fn).toContain("e.is_practice is true");
    // the room never changes, except the FK's SET NULL when a room is deleted (0051)
    expect(fn).toMatch(/new\.event_id is distinct from old\.event_id and new\.event_id is not null then raise/);
  });

  it("a room that moves band takes its rows along", () => {
    expect(triggerLives("practice_rows_follow_their_room", "events", /^after update of group_id$/)).toBe(true);
    const fn = lastFunction("practice_rows_follow_their_room");
    for (const t of ["practice_songs", "practice_logs", "practice_attendance", "practice_runs"]) {
      expect(fn).toContain(`update public.${t} set group_id = new.group_id where event_id = new.id`);
    }
  });
});

describe("a show's run time is an admin's record (0052)", () => {
  it("guard_event_update refuses a non-admin editor's last_run change", () => {
    const fn = lastFunction("guard_event_update");
    expect(fn).toMatch(
      /new\.last_run_seconds is distinct from old\.last_run_seconds or new\.last_run_at is distinct from old\.last_run_at\) and not public\.can_admin_tenant\(old\.tenant_id\) then raise/
    );
    // and the approver-only branch still refuses it outright
    expect(fn).toContain("raise exception 'label_staff may only change event status'");
  });

  it("a non-admin's new event starts with no run time", () => {
    const fn = lastFunction("force_event_unapproved_on_insert");
    expect(fn).toMatch(/not public\.can_admin_tenant\(new\.tenant_id\) then new\.last_run_seconds := null; new\.last_run_at := null;/);
    expect(fn).toContain("new.status := 'draft'");
  });
});
