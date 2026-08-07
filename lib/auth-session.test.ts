// "An empty read is not an empty table."
//
// This one-function module is the whole basis of that rule, and it is quoted in
// nearly every commit message in this repo, so its truth table is worth pinning
// exactly: supabase-js substitutes the ANON key whenever getSession() hands back
// null, RLS answers an anon request with [] and no error, and every verdict drawn
// from that empty answer is wrong.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSupabaseFake, type SupabaseFake } from "@/test/fakes/supabase";

const h = vi.hoisted(() => ({ supa: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.supa }));

import { hasLiveSession } from "@/lib/auth-session";

let supa: SupabaseFake;
beforeEach(() => {
  supa = makeSupabaseFake();
  h.supa = supa;
});

describe("hasLiveSession", () => {
  it("a session carrying an access token means the next request goes out as this user", async () => {
    supa.auth.setSession(makeSession());
    expect(await hasLiveSession()).toBe(true);
  });

  it("no session at all means the next request goes out as anon", async () => {
    supa.auth.setSession(null);
    expect(await hasLiveSession()).toBe(false);
  });

  // The exact shape auth-js leaves behind when a refresh failed: the session object
  // survives, the token it would have been sent with does not. `!!session` would
  // read this as signed in and hand the caller the wrong verdict.
  it("a session whose access token is gone is NOT live", async () => {
    supa.auth.setSession(makeSession({ access_token: "" }));
    expect(await hasLiveSession()).toBe(false);

    const noToken = makeSession();
    delete (noToken as { access_token?: string }).access_token;
    supa.auth.setSession(noToken);
    expect(await hasLiveSession()).toBe(false);
  });

  it("a getSession that rejects answers false rather than propagating", async () => {
    supa.auth.getSession.mockRejectedValueOnce(new Error("storage is not available"));
    expect(await hasLiveSession()).toBe(false);
  });

  // The desktop build swaps in a different client under file://; if constructing it
  // throws, the caller still needs an answer — and "assume anon" is the safe one,
  // because it makes every caller keep its offline copy.
  it("a client that cannot even be constructed answers false", async () => {
    h.supa = null;
    expect(await hasLiveSession()).toBe(false);
  });

  // getUser() is a network round trip. At a venue with no uplink it would hang or
  // fail, and this question has to be answerable offline — it is asked precisely
  // when the network has just come back.
  it("asks the local session only, never getUser", async () => {
    supa.auth.setSession(makeSession());
    await hasLiveSession();
    expect(supa.auth.getSession).toHaveBeenCalledTimes(1);
    expect(supa.auth.getUser).not.toHaveBeenCalled();
  });

  // auth-js caches a failed refresh for about a minute — the same minute a venue
  // reconnect lands in. Nothing here may cache: the whole point is that the NEXT
  // attempt gets a fresh answer, so a late sign-in upgrades the verdict.
  it("re-asks every time, so a session that arrives late flips the answer", async () => {
    expect(await hasLiveSession()).toBe(false);
    supa.auth.setSession(makeSession());
    expect(await hasLiveSession()).toBe(true);
    supa.auth.setSession(null);
    expect(await hasLiveSession()).toBe(false);
    expect(supa.auth.getSession).toHaveBeenCalledTimes(3);
  });
});
