import { describe, it, expect, beforeEach } from "vitest";
import { getStoredSessionUser } from "./stored-session";

// This function IS the offline show pass. If it answers null at a venue with no
// internet, the app bounces to /login and the night is over — every cached page
// and every cached master is still on disk and unreachable. If it answers YES to
// something that is not a real persisted session, the app boots into a shell that
// can never come back to life online. Both directions are worth a test, and the
// only reason this could not be tested before is that it reads window.localStorage
// and the whole suite ran in node.

const KEY = "sb-kewyqqxohckurwuepucv-auth-token";

const session = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    access_token: "expired.jwt.value",
    refresh_token: "r3fr3sh",
    expires_at: 1,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "seishin-mem@cueiq.local" },
    ...over,
  });

beforeEach(() => {
  window.localStorage.clear();
});

describe("getStoredSessionUser", () => {
  it("returns null when nothing was ever stored", () => {
    expect(getStoredSessionUser()).toBeNull();
  });

  it("honours a persisted session whose access token has long expired", () => {
    // The whole point: expiry is IRRELEVANT here. supabase-js returns session:null
    // for this exact state when it cannot reach the server to refresh, and that is
    // the state a cold boot hours after the last online use is always in.
    window.localStorage.setItem(KEY, session());
    expect(getStoredSessionUser()).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      email: "seishin-mem@cueiq.local",
    });
  });

  it("refuses a session with no refresh token", () => {
    // Without one it can never be upgraded to a real session when the network
    // returns, so honouring it offline would strand the app in a read-only ghost.
    window.localStorage.setItem(KEY, session({ refresh_token: undefined }));
    expect(getStoredSessionUser()).toBeNull();
  });

  it("refuses a session with no user id", () => {
    window.localStorage.setItem(KEY, session({ user: { email: "x@y.z" } }));
    expect(getStoredSessionUser()).toBeNull();
  });

  it("tolerates a missing email", () => {
    window.localStorage.setItem(
      KEY,
      session({ user: { id: "22222222-2222-4222-8222-222222222222" } })
    );
    expect(getStoredSessionUser()).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      email: null,
    });
  });

  it("ignores keys that are not a supabase auth token", () => {
    window.localStorage.setItem("cueiq-theme", "dark");
    window.localStorage.setItem("sb-project-other", session());
    expect(getStoredSessionUser()).toBeNull();
  });

  it("does not let one corrupt entry hide a valid session under another key", () => {
    // Two Supabase projects (or a stale ref after a project move) can leave two
    // sb-*-auth-token keys behind. Bailing on the first unparseable one would take
    // the show offline pass away for a reason the operator can never see.
    window.localStorage.setItem("sb-dead-auth-token", "{not json");
    window.localStorage.setItem(KEY, session());
    expect(getStoredSessionUser()?.id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("treats an empty stored value as absent", () => {
    window.localStorage.setItem(KEY, "");
    expect(getStoredSessionUser()).toBeNull();
  });
});

describe("the offline smoke seed and this reader agree", () => {
  // The packaged-app self-test plants desktop/scripts/make-smoke-seed.mjs's output
  // into localStorage and then asserts the app boots SIGNED IN with no network. If
  // that seed ever stops satisfying the rule below, the smoke does not fail loudly
  // — it fails as "the app bounced to login", which reads like an app regression
  // and costs a twenty-minute release build to discover. Check it here in 50ms.
  it("produces exactly what the offline pass requires", async () => {
    const { buildSmokeSeed } = await import("../../scripts/make-smoke-seed.mjs");
    const seed = buildSmokeSeed();

    const keys = Object.keys(seed);
    const authKeys = keys.filter((k) => /^sb-.+-auth-token$/.test(k));
    expect(authKeys).toHaveLength(1);

    for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
    const user = getStoredSessionUser();
    expect(user).not.toBeNull();
    expect(user?.id).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("keeps the cached workspace's owner equal to the session's user", async () => {
    // ~/data/workspace.ts only serves the cache when cached.user.id matches the
    // STORED session's id — the shared-band-device privacy boundary. If the fixture
    // ever drifts, the smoke boots signed in with an EMPTY workspace and the failure
    // reads as "the offline cache is broken" rather than "the fixture disagrees".
    const { buildSmokeSeed } = await import("../../scripts/make-smoke-seed.mjs");
    const seed = buildSmokeSeed();
    const authKey = Object.keys(seed).find((k) => /^sb-.+-auth-token$/.test(k))!;
    const session = JSON.parse(seed[authKey]);
    const workspace = JSON.parse(seed["cueiq:cache:workspace"]);
    expect(workspace.user.id).toBe(session.user.id);
    expect(workspace.membership.tenant_id).toBeTruthy();
  });

  it("derives the events cache key the way events-list.ts builds it", async () => {
    // `events:<tenantId>:<viewable group ids, sorted, comma-joined>`. Getting this
    // wrong is invisible: the app boots perfectly and shows zero shows.
    const { buildSmokeSeed, SMOKE_EVENT_COUNT } = await import(
      "../../scripts/make-smoke-seed.mjs"
    );
    const seed = buildSmokeSeed();
    const workspace = JSON.parse(seed["cueiq:cache:workspace"]);
    const expectedKey =
      `cueiq:cache:events:${workspace.membership.tenant_id}:` +
      workspace.groups
        .map((g: { id: string }) => g.id)
        .sort()
        .join(",");
    expect(Object.keys(seed)).toContain(expectedKey);
    expect(JSON.parse(seed[expectedKey])).toHaveLength(SMOKE_EVENT_COUNT);
  });

  it("carries no live credential — the token is expired and unsigned", async () => {
    const { buildSmokeSeed } = await import("../../scripts/make-smoke-seed.mjs");
    const stored = JSON.parse(Object.values(buildSmokeSeed())[0] as string);
    expect(stored.expires_at * 1000).toBeLessThan(Date.parse("2026-01-01"));
    expect(stored.access_token.split(".")[2]).toBe("not-a-real-signature");
  });
});
