// lib/sign-out-intent.ts rests on two facts about auth-js that no mock can prove:
//   1. auth-js runs onAuthStateChange listeners INSIDE signOut() — so a flag held for
//      the length of that call is what the desktop's SIGNED_OUT listener sees;
//   2. a refresh the server rejects for good (the refresh token was revoked from
//      another device) emits the very same SIGNED_OUT, with no sign-out call around it.
// If a future auth-js defers its listeners (a setTimeout, a queue), every deliberate
// sign-out would read as involuntary and the queue would never be wiped — this goes
// red first. Real supabase-js, real HTTP, the smoke backend's real token rotation.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SMOKE_WORLD, startSmokeBackend } from "../../scripts/smoke-backend.mjs";
import { duringDeliberateSignOut, isDeliberateSignOut } from "@/lib/sign-out-intent";

type Backend = { url: string; close: () => Promise<void> };
const ANON_KEY = "sb_publishable_smoke_backend_fixture";
const STORAGE_KEY = "sign-out-intent-test";

/** A storage of its own: test/setup/dom.ts clears window.localStorage between tests,
 *  and this test has to reach in and age the stored session. */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

function device(
  url: string,
  storage: ReturnType<typeof memoryStorage>,
  // Its own key per DEVICE: auth-js broadcasts auth events to every client on the
  // same key (BroadcastChannel — two windows of one app), and two real devices share
  // no such channel.
  storageKey = STORAGE_KEY
): SupabaseClient {
  return createClient(url, ANON_KEY, {
    auth: {
      storage,
      storageKey,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

const signIn = (c: SupabaseClient) =>
  c.auth.signInWithPassword({ email: SMOKE_WORLD.auth.email, password: SMOKE_WORLD.auth.password });

/** Every SIGNED_OUT the client emits, with whether it arrived inside a deliberate sign-out. */
function watch(c: SupabaseClient): boolean[] {
  const seen: boolean[] = [];
  c.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") seen.push(isDeliberateSignOut());
  });
  return seen;
}

let backend: Backend;
beforeEach(async () => {
  backend = (await startSmokeBackend()) as Backend;
});
afterEach(async () => {
  await backend.close();
});

describe("sign-out intent against the real auth-js", () => {
  it("a sign-out the person pressed reaches the listener while the flag is held", async () => {
    const laptop = device(backend.url, memoryStorage());
    const seen = watch(laptop);
    expect((await signIn(laptop)).error).toBeNull();

    const { error } = await duringDeliberateSignOut(() => laptop.auth.signOut({ scope: "local" }));

    expect(error).toBeNull();
    expect(seen).toEqual([true]);
    expect(isDeliberateSignOut()).toBe(false);
  });

  it("a refresh token revoked from another device signs the laptop out with no flag", async () => {
    const store = memoryStorage();
    const laptop = device(backend.url, store);
    const seen = watch(laptop);
    expect((await signIn(laptop)).error).toBeNull();

    // The phone signs out of every device (what 0.1.43 did): the server forgets every
    // token it issued, the laptop's refresh token included.
    const phone = device(backend.url, memoryStorage(), "sign-out-intent-test-phone");
    expect((await signIn(phone)).error).toBeNull();
    expect((await phone.auth.signOut({ scope: "global" })).error).toBeNull();

    // Hours later the laptop's access token has expired: the next getSession() must
    // refresh, the server says refresh_token_not_found, and auth-js drops the session.
    const stored = JSON.parse(store.map.get(STORAGE_KEY)!);
    store.map.set(
      STORAGE_KEY,
      JSON.stringify({ ...stored, expires_at: Math.floor(Date.now() / 1000) - 3600 })
    );
    const { data } = await laptop.auth.getSession();

    expect(data.session).toBeNull();
    expect(store.map.has(STORAGE_KEY)).toBe(false);
    expect(seen).toEqual([false]); // involuntary: the desktop keeps its queue
  });
});
