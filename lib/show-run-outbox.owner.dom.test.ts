// Whose run time is it? (2026-10-30, hunt 10)
//
// The show-run queue outlives a sign-out, and it carried no owner. On a shared machine
// the NEXT account to sign in replayed the last one's offline จบโชว์ under its own
// session - and judged it there: a band that account cannot see answers the "is the
// event gone?" probe with nothing (events_select = can_view_group), so the only copy of
// a night's run time was DELETED. Each op now carries the account signed in when it was
// queued (read synchronously from the stored session - never a network wait on the
// จบโชว์ path), and a flush leaves another account's op untouched until it signs in again.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSupabaseFake, ok, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { countQueuedShowRunWork, enqueue, flushOutbox, pendingCount, storedSessionUserId } from "@/lib/show-run-outbox";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const AT = 1_761_900_000_000;

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });
}

/** What the desktop client persists (localStorage, desktop/src/shims/supabase-client.ts). */
function signInDesktop(userId: string | null) {
  for (let i = window.localStorage.length - 1; i >= 0; i--) {
    const k = window.localStorage.key(i);
    if (k && /^sb-.+-auth-token$/.test(k)) window.localStorage.removeItem(k);
  }
  if (userId) {
    window.localStorage.setItem(
      "sb-testref-auth-token",
      JSON.stringify({ access_token: "t", refresh_token: "r", user: { id: userId, email: "x@cueiq.local" } })
    );
  }
}

function clearCookies() {
  for (const raw of document.cookie.split(";")) {
    const name = raw.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Max-Age=0; path=/`;
  }
}

/** What @supabase/ssr persists on the web: `base64-` + base64url(JSON), split into
 *  `.0`, `.1`… chunks when long. */
function signInWeb(userId: string, chunked: boolean) {
  const json = JSON.stringify({
    access_token: "t".repeat(chunked ? 4000 : 10),
    refresh_token: "r",
    user: { id: userId, user_metadata: { full_name: "ไหม Seishin" } },
  });
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  const value = "base64-" + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (!chunked) {
    document.cookie = `sb-testref-auth-token=${value}; path=/`;
    return;
  }
  const half = Math.ceil(value.length / 2);
  document.cookie = `sb-testref-auth-token.0=${value.slice(0, half)}; path=/`;
  document.cookie = `sb-testref-auth-token.1=${value.slice(half)}; path=/`;
}

let supa: SupabaseFake;
beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  signInDesktop(null);
  clearCookies();
  // the session every request goes out with - B unless a test says otherwise
  supa = makeSupabaseFake({ session: makeSession({ user: { id: B } as never }) });
  h.supa = supa;
});
afterEach(() => {
  signInDesktop(null);
  clearCookies();
});

const op = (eventId: string, seconds = 1200) => ({ kind: "event_last_run" as const, eventId, seconds, at: AT });

describe("another account's run time waits for it", () => {
  it("is neither sent nor dropped as 'gone' when another account flushes", async () => {
    signInDesktop(A);
    await enqueue(op("ev-A"));
    signInDesktop(B); // A signed out, B signed in on the same machine
    // B's RLS: the update touches nothing and the event reads as absent
    supa.setTable("events", () => ok([]));
    await flushOutbox();
    // still on the device - but no longer in B's "รอซิงค์" (pendingCount counts only the
    // account signed in since hunt 11), so asked of the whole queue
    expect(await countQueuedShowRunWork()).toBe(1);
    expect(await pendingCount()).toBe(0);
    expect(supa.callsTo("events")).toHaveLength(0);
  });

  it("goes out once its own account signs in again", async () => {
    signInDesktop(A);
    await enqueue(op("ev-A", 754));
    signInDesktop(B);
    supa.setTable("events", () => ok([]));
    await flushOutbox();

    signInDesktop(A);
    supa.auth.setSession(makeSession({ user: { id: A } as never }));
    supa.setTable("events", (call) => ok(call.verb === "update" ? [{ id: "ev-A" }] : []));
    const r = await flushOutbox();
    expect(r).toEqual({ flushed: 1, remaining: 0 });
    expect(supa.callsTo("events", "update")[0].values).toMatchObject({ last_run_seconds: 754 });
  });

  it("does not hold up the signed-in account's own ops queued beside it", async () => {
    signInDesktop(A);
    await enqueue(op("ev-A"));
    signInDesktop(B);
    await enqueue(op("ev-B", 900));
    supa.setTable("events", (call) => ok(call.verb === "update" ? [{ id: call.eq.id }] : []));
    const r = await flushOutbox();
    expect(r).toEqual({ flushed: 1, remaining: 1 });
    expect(supa.callsTo("events", "update").map((c) => c.eq.id)).toEqual(["ev-B"]);
  });
});

describe("the same account: exactly as before", () => {
  it("flushes its own op", async () => {
    signInDesktop(B);
    await enqueue(op("ev-B"));
    supa.setTable("events", (call) => ok(call.verb === "update" ? [{ id: "ev-B" }] : []));
    expect(await flushOutbox()).toEqual({ flushed: 1, remaining: 0 });
  });

  it("still drops an op whose event its own account sees is gone", async () => {
    signInDesktop(B);
    await enqueue(op("ev-deleted"));
    supa.setTable("events", () => ok([]));
    await flushOutbox();
    expect(await pendingCount()).toBe(0);
  });

  it("an op with no owner (queued by an older build) replays for whoever is signed in", async () => {
    await enqueue(op("ev-old")); // nobody in storage: no owner stamped
    signInDesktop(B);
    supa.setTable("events", (call) => ok(call.verb === "update" ? [{ id: "ev-old" }] : []));
    expect(await flushOutbox()).toEqual({ flushed: 1, remaining: 0 });
  });

  it("with nobody signed in on the device, the owner check stays out of the way (anon keeps it queued)", async () => {
    signInDesktop(A);
    await enqueue(op("ev-A"));
    signInDesktop(null);
    supa.auth.setSession(null);
    supa.setTable("events", () => ok([]));
    await flushOutbox();
    expect(supa.callsTo("events", "update")).toHaveLength(1); // tried, as before
    expect(await pendingCount()).toBe(1); // ...and kept: no session, no verdict
  });
});

describe("the owner is read without waiting on anything", () => {
  it("enqueue completes with every auth call hanging - it never asks auth-js", async () => {
    signInDesktop(A);
    supa.auth.hang("all");
    await enqueue(op("ev-A"));
    expect(await pendingCount()).toBe(1);
    expect(supa.auth.getSession).not.toHaveBeenCalled();
    expect(supa.auth.getUser).not.toHaveBeenCalled();
  });

  it("reads the web client's cookie, whole or in chunks", () => {
    signInWeb(A, false);
    expect(storedSessionUserId()).toBe(A);
    clearCookies();
    signInWeb(A, true);
    expect(storedSessionUserId()).toBe(A);
  });

  it("two different accounts in storage, or none, is 'unknown'", () => {
    expect(storedSessionUserId()).toBeNull();
    signInDesktop(A);
    expect(storedSessionUserId()).toBe(A);
    signInWeb(B, false);
    expect(storedSessionUserId()).toBeNull();
  });
});

describe("countQueuedShowRunWork", () => {
  it("counts run times and running-order presses, every account's", async () => {
    signInDesktop(A);
    await enqueue(op("ev-A"));
    signInDesktop(B);
    await enqueue(op("ev-B"));
    const { enqueueRunSeq } = await import("@/lib/run-order-outbox");
    await enqueueRunSeq({
      rowId: "row-1",
      festival: "f",
      patch: { status: "live" },
      expect: { status: "pending" },
      label: "เริ่ม",
      queuedAt: Date.now(),
    });
    expect(await countQueuedShowRunWork()).toBe(3);
  });

  it("is 0 on a machine that never queued anything - and does not create the database", async () => {
    expect(await countQueuedShowRunWork()).toBe(0);
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).not.toContain("cueiq-outbox");
  });
});
