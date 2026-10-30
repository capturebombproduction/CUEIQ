// The Live strip's "รอซิงค์ N" counts this account's run times only (2026-10-30, hunt 11).
//
// A run time queued by ANOTHER account on this device is not sent while this one is signed
// in (hunt 10, flushOutbox) - but pendingCount counted it, so the strip said "รอซิงค์ 1" in
// every show, for an account that could neither send it nor clear it. An op with no owner
// (an older build, an unreadable session) replays for whoever is signed in, so it counts.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { enqueue, pendingCount } from "@/lib/show-run-outbox";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
    req.onerror = () => resolve();
  });
}
function signIn(userId: string | null) {
  window.localStorage.removeItem("sb-testref-auth-token");
  if (userId)
    window.localStorage.setItem(
      "sb-testref-auth-token",
      JSON.stringify({ access_token: "t", refresh_token: "r", user: { id: userId } })
    );
}

beforeEach(async () => {
  await deleteDB("cueiq-outbox");
  h.supa = makeSupabaseFake({ session: makeSession() });
  signIn(null);
});

describe("pendingCount · this account's queue", () => {
  it("another account's run time is not counted; this account's and an owner-less one are", async () => {
    signIn(A);
    await enqueue({ kind: "event_last_run", eventId: "ev-a", seconds: 754, at: 1 });
    signIn(null); // nobody readable: queued with no owner
    await enqueue({ kind: "event_last_run", eventId: "ev-old", seconds: 600, at: 2 });
    signIn(B);
    await enqueue({ kind: "event_last_run", eventId: "ev-b", seconds: 1200, at: 3 });
    expect(await pendingCount()).toBe(2); // B's + the owner-less one
    signIn(A);
    expect(await pendingCount()).toBe(2); // A's + the owner-less one
  });

  it("with nobody readable signed in, everything counts (as before)", async () => {
    signIn(A);
    await enqueue({ kind: "event_last_run", eventId: "ev-a", seconds: 754, at: 1 });
    signIn(null);
    expect(await pendingCount()).toBe(1);
  });
});
