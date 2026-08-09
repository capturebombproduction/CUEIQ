// Is the local Supabase stub faithful enough to be worth trusting?
//
// desktop/scripts/smoke-backend.mjs exists so the offline smoke can watch the REAL
// packaged app sign in, read, and fill its OWN caches before the network is cut.
// That only means something if the stub answers the way production answers: the
// moment it diverges, the smoke proves a protocol nobody ships against.
//
// So nothing here asserts on the stub's internals. Every check below drives a REAL
// supabase-js client — the same version the desktop app bundles, aliased to the
// root copy by vitest.config.ts — at a real HTTP server on a real socket, and
// asserts on what the CLIENT observed. If postgrest-js changes how it encodes a
// filter or unpacks a single row, this file goes red, which is the whole point.
//
// The cases picked are the ones where a stub silently diverges rather than
// obviously breaks: the single-object media type, an empty result that should have
// been filtered rather than absent, and an embedded select the dashboard's cached
// rows depend on.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  SMOKE_EVENT_COUNT,
  SMOKE_TENANT_NAME,
  SMOKE_WORLD,
  startSmokeBackend,
  // A plain dependency-free .mjs, by design — it has to be importable by `node`
  // straight from the smoke runner. tsc infers its shape from the JS, which is
  // why there is no `@ts-expect-error` here and why a fixture typo still fails
  // the typecheck rather than only the run.
} from "../../scripts/smoke-backend.mjs";

type Backend = {
  url: string;
  requests: { method: string; path: string; query: Record<string, string>; status: number }[];
  unimplementedPaths: string[];
  close: () => Promise<void>;
};

const ANON_KEY = "sb_publishable_smoke_backend_fixture";

const clientFor = (url: string, storageKey: string): SupabaseClient =>
  createClient(url, ANON_KEY, {
    auth: {
      // In MEMORY, not localStorage: test/setup/dom.ts clears window.localStorage
      // after every test, which would sign this client out between cases and turn
      // every later read into the anon 401 the stub is right to send.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey,
    },
  });

let backend: Backend;
let supabase: SupabaseClient;

beforeAll(async () => {
  // Port 0: parallel test files (and a smoke running on the same machine) must not
  // collide on a fixed port.
  backend = (await startSmokeBackend()) as Backend;
  supabase = clientFor(backend.url, "smoke-backend-authed");
});

afterAll(async () => {
  await backend?.close();
});

describe("sign-in", () => {
  it("returns a session supabase-js accepts and stores", async () => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: SMOKE_WORLD.auth.email,
      password: SMOKE_WORLD.auth.password,
    });

    // auth-js answers AuthInvalidTokenResponseError — not a network error — when a
    // /token response is missing access_token, refresh_token OR expires_in. That is
    // the silent sign-in failure worth guarding: the smoke would then run every
    // read as anon and conclude the caches do not fill.
    expect(error).toBeNull();
    expect(data.session).not.toBeNull();
    expect(data.user?.id).toBe(SMOKE_WORLD.ids.user);

    const session = data.session!;
    expect(session.token_type).toBe("bearer");
    expect(session.refresh_token).toBeTruthy();
    expect(session.expires_in).toBeGreaterThan(0);
    // expires_at is what auth-js compares against the clock on every cold boot —
    // and what ~/data/stored-session.ts reads out of the persisted entry.
    expect(session.expires_at! * 1000).toBeGreaterThan(Date.now());
  });

  it("mints a three-segment JWT carrying sub, exp, role and aud", async () => {
    const { data } = await supabase.auth.getSession();
    const parts = data.session!.access_token.split(".");
    expect(parts).toHaveLength(3);

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    expect(payload.sub).toBe(SMOKE_WORLD.ids.user);
    expect(payload.role).toBe("authenticated");
    expect(payload.aud).toBe("authenticated");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("serves GET /auth/v1/user for the token it issued", async () => {
    // loadWorkspace() calls exactly this, and treats a null user as "fall back to
    // the cache" — so a stub that answered the wrong shape here would make the
    // online phase look like a blip and write no cache at all.
    const { data, error } = await supabase.auth.getUser();
    expect(error).toBeNull();
    expect(data.user?.id).toBe(SMOKE_WORLD.ids.user);
    expect(data.user?.user_metadata.full_name).toBe(SMOKE_WORLD.auth.fullName);
  });

  it("rejects a wrong password loudly instead of handing back an anon client", async () => {
    const other = clientFor(backend.url, "smoke-backend-badpass");
    const { data, error } = await other.auth.signInWithPassword({
      email: SMOKE_WORLD.auth.email,
      password: "not-the-fixture-password",
    });
    expect(data.session).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.status).toBe(400);
    expect(error!.code).toBe("invalid_credentials");
  });

  it("honours grant_type=refresh_token, and rotates the token it consumed", async () => {
    const before = (await supabase.auth.getSession()).data.session!;
    const { data, error } = await supabase.auth.refreshSession();
    expect(error).toBeNull();
    expect(data.session).not.toBeNull();
    expect(data.session!.access_token).not.toBe(before.access_token);
    expect(data.session!.refresh_token).not.toBe(before.refresh_token);

    // Replaying the spent refresh token must fail. A stub that accepted it forever
    // would hide a client that never stored the rotated one — which at a venue is
    // a session that dies the first time the laptop sleeps.
    const replay = clientFor(backend.url, "smoke-backend-replay");
    const { error: replayError } = await replay.auth.refreshSession({
      refresh_token: before.refresh_token,
    });
    expect(replayError).not.toBeNull();
    expect(replayError!.status).toBe(400);
  });
});

describe("PostgREST — every table the app reads", () => {
  // The exact list ~/data/workspace.ts, events-list.ts, event-bundle.ts,
  // song-library.ts and run-order.ts issue reads against. A table missing here is
  // a screen that cannot fill its cache.
  const expected: Record<string, number> = {
    tenant_members: 1,
    group_roles: 0,
    tenants: 1,
    groups: 1,
    events: 3, // two shows + one template
    schedule_items: 4,
    setlist_items: 3,
    mic_assignments: 2,
    members: 3,
    songs: 2,
    event_members: 2,
    run_sequence: 3,
  };

  for (const [table, count] of Object.entries(expected)) {
    it(`serves ${table}`, async () => {
      const { data, error } = await supabase.from(table).select("*");
      expect(error).toBeNull();
      expect(data).toHaveLength(count);
    });
  }

  it("reproduces the dashboard's own events query, filters and all", async () => {
    // Copied from ~/data/events-list.ts. The template row must not appear, and the
    // count must equal what the offline half of the airplane test asserts.
    const { data, error } = await supabase
      .from("events")
      .select("*, groups(name, color, exempt_from_deadline)")
      .eq("tenant_id", SMOKE_WORLD.ids.tenant)
      .in("group_id", [SMOKE_WORLD.ids.group])
      .eq("is_template", false)
      .eq("is_practice", false)
      .order("event_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    expect(error).toBeNull();
    expect(data).toHaveLength(SMOKE_EVENT_COUNT);
    expect(data!.map((row) => row.id)).toEqual(SMOKE_WORLD.ids.events);
  });

  it("returns the embedded groups select NESTED, projected to the asked-for columns", async () => {
    const { data, error } = await supabase
      .from("events")
      .select("*, groups(name, color, exempt_from_deadline)")
      .eq("id", SMOKE_WORLD.ids.richEvent)
      .maybeSingle();

    expect(error).toBeNull();
    // Not a flat `groups_name`, not an array — the shared EventsList component
    // reads `row.groups.name`, and the offline seed caches exactly this shape.
    expect(data!.groups).toEqual({
      name: SMOKE_WORLD.groupName,
      color: "#A62A1C",
      exempt_from_deadline: false,
    });
  });

  it("returns the embed ALONE when no base column was selected", async () => {
    // PostgREST's rule, and the reason project() does not treat an empty column
    // list as "*": a stub that answered richer than production would let a caller
    // read a field it never selected and only fail at the venue.
    const { data, error } = await supabase
      .from("events")
      .select("groups(name)")
      .eq("id", SMOKE_WORLD.ids.richEvent)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toEqual({ groups: { name: SMOKE_WORLD.groupName } });
  });

  it("supports the event page's whole-row embed too", async () => {
    const { data, error } = await supabase
      .from("events")
      .select("*, groups(*)")
      .eq("id", SMOKE_WORLD.ids.richEvent)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data!.groups.id).toBe(SMOKE_WORLD.ids.group);
    expect(data!.groups.tenant_id).toBe(SMOKE_WORLD.ids.tenant);
  });

  it("gives the rich event something to cache: setlist, schedule, mics, lineup", async () => {
    const [schedule, setlist, mics, lineup] = await Promise.all([
      supabase.from("schedule_items").select("*").eq("event_id", SMOKE_WORLD.ids.richEvent),
      supabase.from("setlist_items").select("*").eq("event_id", SMOKE_WORLD.ids.richEvent),
      supabase.from("mic_assignments").select("*").eq("event_id", SMOKE_WORLD.ids.richEvent),
      supabase.from("event_members").select("member_id").eq("event_id", SMOKE_WORLD.ids.richEvent),
    ]);
    expect(schedule.data).toHaveLength(3);
    expect(setlist.data).toHaveLength(3);
    expect(mics.data).toHaveLength(2);
    // Projected: event-bundle.ts maps `r.member_id`, so this read must not come
    // back as whole rows when only one column was asked for.
    expect(lineup.data).toEqual([{ member_id: expect.any(String) }, { member_id: expect.any(String) }]);
  });
});

describe("PostgREST — the parts of the protocol that silently diverge", () => {
  it("maybeSingle over exactly one row gives an OBJECT", async () => {
    const { data, error } = await supabase
      .from("tenants")
      .select("*")
      .eq("id", SMOKE_WORLD.ids.tenant)
      .maybeSingle();
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(false);
    expect(data!.name).toBe(SMOKE_TENANT_NAME);
  });

  it("maybeSingle over zero rows gives null with NO error", async () => {
    // The difference that decides whether ~/data/event-bundle.ts says "this show
    // was deleted" or "we could not reach it". An error here would be the wrong
    // answer in the safe direction; a row here would be the wrong answer in the
    // dangerous one.
    const { data, error } = await supabase
      .from("tenants")
      .select("*")
      .eq("id", "00000000-0000-4000-8000-0000000000ff")
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("maybeSingle over many rows gives a PGRST116 error at 406", async () => {
    const { data, error, status } = await supabase.from("events").select("*").maybeSingle();
    expect(data).toBeNull();
    expect(error?.code).toBe("PGRST116");
    expect(status).toBe(406);
  });

  it("single() sends the object media type, and the SERVER answers it", async () => {
    // maybeSingle() synthesizes PGRST116 client-side in this postgrest-js version,
    // so it cannot prove the server side. single() actually sends
    // `Accept: application/vnd.pgrst.object+json` — the header a stub most easily
    // ignores, handing an array to a caller expecting an object.
    const one = await supabase
      .from("groups")
      .select("*")
      .eq("id", SMOKE_WORLD.ids.group)
      .single();
    expect(one.error).toBeNull();
    expect(one.data!.name).toBe(SMOKE_WORLD.groupName);

    const many = await supabase.from("events").select("*").single();
    expect(many.data).toBeNull();
    expect(many.error?.code).toBe("PGRST116");
    expect(many.status).toBe(406);

    const none = await supabase.from("events").select("*").eq("name", "no such show").single();
    expect(none.data).toBeNull();
    expect(none.error?.code).toBe("PGRST116");
    expect(none.status).toBe(406);

    // Proof it was the SERVER: postgrest-js only fabricates PGRST116 for
    // maybeSingle over an array, so a 406 could not have come from the client.
    const rest = backend.requests.filter((r) => r.path === "/rest/v1/events");
    expect(rest.some((r) => r.status === 406)).toBe(true);
  });

  it("an eq filter actually filters", async () => {
    const templates = await supabase.from("events").select("*").eq("is_template", true);
    expect(templates.data).toHaveLength(1);
    expect(templates.data![0].id).toBe(SMOKE_WORLD.ids.templateEvent);

    const shows = await supabase.from("events").select("*").eq("is_template", false);
    expect(shows.data).toHaveLength(SMOKE_EVENT_COUNT);
  });

  it("an in filter matches the set, and an empty match is an empty ARRAY not an error", async () => {
    const mine = await supabase.from("songs").select("*").in("group_id", [SMOKE_WORLD.ids.group]);
    expect(mine.error).toBeNull();
    expect(mine.data).toHaveLength(2);

    const other = await supabase
      .from("songs")
      .select("*")
      .in("group_id", ["00000000-0000-4000-8000-0000000000ee"]);
    expect(other.error).toBeNull();
    expect(other.data).toEqual([]);
  });

  it("is.null selects the null-dated festival, not everything", async () => {
    // ~/data/run-order.ts switches between eq.<date> and is.null for the same
    // query. A stub that ignored `is.` would answer all three rows and the run
    // order would look correct for the wrong festival.
    const dateless = await supabase.from("run_sequence").select("*").is("event_date", null);
    expect(dateless.error).toBeNull();
    expect(dateless.data).toHaveLength(1);
    expect(dateless.data![0].event_name).toBe("Smoke Dateless");

    const dated = await supabase
      .from("run_sequence")
      .select("*")
      .eq("event_name", "Smoke Show 1")
      .eq("event_date", "2026-12-01")
      .order("sort_order", { ascending: true });
    expect(dated.data!.map((r) => r.sort_order)).toEqual([0, 1]);
  });

  it("honours order + limit, because workspace.ts pairs them with maybeSingle", async () => {
    // `.order(created_at).limit(1).maybeSingle()` on tenant_members decides the
    // ROLE for the whole session. If limit were ignored and a second membership
    // existed, maybeSingle would answer PGRST116 and the app would show no label.
    const { data, error } = await supabase
      .from("tenant_members")
      .select("tenant_id, role")
      .eq("user_id", SMOKE_WORLD.ids.user)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toEqual({ tenant_id: SMOKE_WORLD.ids.tenant, role: "admin" });

    const descending = await supabase
      .from("events")
      .select("event_date")
      .order("event_date", { ascending: false, nullsFirst: false });
    // nullslast: the template's null date sorts to the end, exactly as the
    // dashboard's query asks for.
    expect(descending.data!.map((r) => r.event_date)).toEqual(["2026-12-02", "2026-12-01", null]);
  });
});

describe("what it refuses", () => {
  it("answers a LOUD 501 for a table it does not serve — never an empty 200", async () => {
    // "An empty read is not an empty table." A stub that answered [] here would
    // let a smoke pass on a screen this fixture never served.
    const { data, error, status } = await supabase.from("staff_contacts").select("*");
    expect(data).toBeNull();
    expect(status).toBe(501);
    expect(error?.code).toBe("SMOKE_UNIMPLEMENTED");
    expect(error?.message).toContain("staff_contacts");
    expect(backend.unimplementedPaths).toContain("GET /rest/v1/staff_contacts");
  });

  it("answers a LOUD 501 for a write, naming the method and path", async () => {
    const { error, status } = await supabase.from("events").insert({ name: "nope" });
    expect(status).toBe(501);
    expect(error?.message).toContain("POST /rest/v1/events");
  });

  it("refuses an unauthenticated read by NAME rather than imitating an RLS empty", async () => {
    // supabase-js falls back to the anon key whenever it has no session, and real
    // RLS answers that with [] and no error — the exact degrade that shipped once
    // in the packaged app (every read ran as anon under file://). The stub makes
    // it a 401 so the smoke cannot mistake it for a table with nothing in it.
    const anon = clientFor(backend.url, "smoke-backend-anon");
    const { data, error, status } = await anon.from("events").select("*");
    expect(data).toBeNull();
    expect(status).toBe(401);
    expect(error?.code).toBe("SMOKE_ANON");
  });
});

describe("CORS, without which nothing reaches the handlers", () => {
  // The packaged renderer runs from file://, so Chromium sends `Origin: null` and
  // preflights every request carrying `apikey` / `authorization` / `x-client-info`.
  // undici does not enforce CORS, so a broken preflight would pass every test above
  // and fail only in the real .exe — check the headers directly.
  it("answers the preflight with the requested headers allowed", async () => {
    const res = await fetch(`${backend.url}/rest/v1/events?select=*`, {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "GET",
        "access-control-request-headers": "apikey,authorization,x-client-info,accept-profile",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("null");
    const allowed = res.headers.get("access-control-allow-headers")!.toLowerCase();
    for (const header of ["apikey", "authorization", "x-client-info", "accept-profile"]) {
      expect(allowed).toContain(header);
    }
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("sends the allow-origin header on real responses too, including errors", async () => {
    const ok = await fetch(`${backend.url}/rest/v1/events?select=*`, {
      headers: { origin: "null" },
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe("null");

    const nope = await fetch(`${backend.url}/nothing/here`, { headers: { origin: "null" } });
    expect(nope.status).toBe(501);
    expect(nope.headers.get("access-control-allow-origin")).toBe("null");
    expect((await nope.json()).message).toContain("/nothing/here");
  });
});

describe("the request log", () => {
  it("records method, path and query in order", async () => {
    const before = backend.requests.length;
    await supabase.from("songs").select("*").eq("tenant_id", SMOKE_WORLD.ids.tenant);
    const recorded = backend.requests.slice(before).filter((r) => r.method === "GET");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].path).toBe("/rest/v1/songs");
    expect(recorded[0].query.tenant_id).toBe(`eq.${SMOKE_WORLD.ids.tenant}`);
    expect(recorded[0].query.select).toBe("*");
  });

  it("shows the sign-in came first, so a scenario can prove the order it ran in", () => {
    const paths = backend.requests.map((r) => r.path);
    expect(paths[0]).toBe("/auth/v1/token");
    expect(paths).toContain("/rest/v1/events");
  });
});

describe("sign-out", () => {
  // Its own backend: logout revokes every token this server issued, which would
  // sign the shared client out and make every later test a 401. A second server is
  // cheaper than an ordering rule nobody remembers.
  it("serves POST /auth/v1/logout and stops honouring the revoked token", async () => {
    const solo = (await startSmokeBackend()) as Backend;
    try {
      const client = clientFor(solo.url, "smoke-backend-signout");
      await client.auth.signInWithPassword({
        email: SMOKE_WORLD.auth.email,
        password: SMOKE_WORLD.auth.password,
      });
      expect((await client.from("events").select("*")).error).toBeNull();

      const { error } = await client.auth.signOut();
      expect(error).toBeNull();
      expect(solo.requests.some((r) => r.path === "/auth/v1/logout" && r.method === "POST")).toBe(
        true
      );

      const after = await client.from("events").select("*");
      expect(after.status).toBe(401);
      expect(after.data).toBeNull();
    } finally {
      await solo.close();
    }
  });
});

describe("the app's OWN loaders fill their OWN caches against it", () => {
  // The point of the whole exercise, checked without Electron. Everything above
  // proves the stub speaks the protocol; this proves the modules that actually run
  // at the venue can drive it end to end and leave behind exactly the localStorage
  // entries the seeded-offline scenario hand-writes. If this is red, the two-phase
  // smoke cannot work no matter what the runner does.
  it("loadWorkspace, loadEventsList and loadEventBundle all write through", async () => {
    // The desktop Supabase shim memoizes one client from process.env at module
    // scope (vite substitutes those textually in the real build), so the env has to
    // be in place BEFORE the module registry hands it out.
    vi.resetModules();
    const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = backend.url;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
    window.localStorage.clear();

    try {
      const { createClient: createDesktopClient } = await import("../shims/supabase-client");
      const signIn = await createDesktopClient().auth.signInWithPassword({
        email: SMOKE_WORLD.auth.email,
        password: SMOKE_WORLD.auth.password,
      });
      expect(signIn.error).toBeNull();

      const { loadWorkspace } = await import("./workspace");
      const workspace = await loadWorkspace();
      expect(workspace.user?.id).toBe(SMOKE_WORLD.ids.user);
      expect(workspace.membership?.role).toBe("admin");
      expect(workspace.tenant?.name).toBe(SMOKE_TENANT_NAME);
      expect(workspace.groups.map((g) => g.id)).toEqual([SMOKE_WORLD.ids.group]);

      const { loadEventsList } = await import("./events-list");
      const list = await loadEventsList(SMOKE_WORLD.ids.tenant, [SMOKE_WORLD.ids.group]);
      expect(list).toHaveLength(SMOKE_EVENT_COUNT);
      expect(list[0].groups?.name).toBe(SMOKE_WORLD.groupName);

      const { loadEventBundle } = await import("./event-bundle");
      const bundle = await loadEventBundle(SMOKE_WORLD.ids.richEvent);
      expect(bundle).not.toBeNull();
      expect(bundle!.event.group?.name).toBe(SMOKE_WORLD.groupName);
      expect(bundle!.setlist).toHaveLength(3);
      expect(bundle!.schedule).toHaveLength(3);
      expect(bundle!.micMap).toHaveLength(2);
      expect(bundle!.members).toHaveLength(3);
      expect(bundle!.songs).toHaveLength(2);
      expect(bundle!.lineup).toHaveLength(2);
      expect(bundle!.role).toBe("admin");

      const { fetchSongs } = await import("./song-library");
      expect(await fetchSongs(SMOKE_WORLD.ids.tenant, [SMOKE_WORLD.ids.group])).toHaveLength(2);

      const { loadRunOrderLive } = await import("./run-order");
      const board = await loadRunOrderLive(SMOKE_WORLD.ids.tenant, SMOKE_WORLD.ids.richEvent);
      expect(board.status).toBe("ok");
      expect(board.status === "ok" && board.data.seqs).toHaveLength(2);

      // …and the entries left on disk are the ones the offline boot reads. These
      // exact keys are what make-smoke-seed.mjs plants by hand.
      const eventsKey = `cueiq:cache:events:${SMOKE_WORLD.ids.tenant}:${SMOKE_WORLD.ids.group}`;
      expect(window.localStorage.getItem("cueiq:cache:workspace")).toBeTruthy();
      expect(JSON.parse(window.localStorage.getItem(eventsKey)!)).toHaveLength(SMOKE_EVENT_COUNT);
      expect(
        window.localStorage.getItem(`cueiq:cache:event:${SMOKE_WORLD.ids.richEvent}`)
      ).toBeTruthy();
      expect(
        window.localStorage.getItem(
          `cueiq:cache:songs:${SMOKE_WORLD.ids.tenant}:${SMOKE_WORLD.ids.group}`
        )
      ).toBeTruthy();
      // The session supabase-js persisted — what ~/data/stored-session.ts scans for
      // on the next, network-less boot.
      expect(Object.keys(window.localStorage).some((k) => /^sb-.+-auth-token$/.test(k))).toBe(true);
    } finally {
      process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey;
      vi.resetModules();
    }
  });
});

describe("it agrees with the offline half of the airplane test", () => {
  // The two fixtures describe ONE world: this stub fills the caches online, and
  // desktop/scripts/make-smoke-seed.mjs hand-writes the same caches for the
  // seeded-offline scenario. If they drift, the smoke fails as "the dashboard shows
  // the wrong band" twenty minutes into a release build. Catch it here in 50ms.
  it("uses the same tenant name and event count, under the same exported names", async () => {
    const seed = await import("../../scripts/make-smoke-seed.mjs");
    expect(SMOKE_TENANT_NAME).toBe(seed.SMOKE_TENANT_NAME);
    expect(SMOKE_EVENT_COUNT).toBe(seed.SMOKE_EVENT_COUNT);
  });

  it("uses the same user, tenant, group and event ids", async () => {
    const { buildSmokeSeed } = await import("../../scripts/make-smoke-seed.mjs");
    const built = buildSmokeSeed() as Record<string, string>;

    const authKey = Object.keys(built).find((k) => /^sb-.+-auth-token$/.test(k))!;
    const session = JSON.parse(built[authKey]);
    const workspace = JSON.parse(built["cueiq:cache:workspace"]);
    const eventsKey = Object.keys(built).find((k) => k.startsWith("cueiq:cache:events:"))!;
    const events = JSON.parse(built[eventsKey]);

    expect(session.user.id).toBe(SMOKE_WORLD.ids.user);
    expect(workspace.membership.tenant_id).toBe(SMOKE_WORLD.ids.tenant);
    expect(workspace.tenant.name).toBe(SMOKE_TENANT_NAME);
    expect(workspace.groups.map((g: { id: string }) => g.id)).toEqual([SMOKE_WORLD.ids.group]);
    expect(workspace.user.name).toBe(SMOKE_WORLD.auth.fullName);
    // Same shows, same order (the seed lists them ascending; the dashboard query
    // sorts descending — compare as sets).
    expect([...events.map((e: { id: string }) => e.id)].sort()).toEqual(
      [...SMOKE_WORLD.ids.events].sort()
    );
  });

  it("serves rows the seeded caches could have been written from", async () => {
    // Not deep equality — the seed is a minimal hand-written cache and the server
    // returns full rows, which is exactly the difference the online phase exists to
    // eliminate. What must match is everything an assertion reads off the screen.
    const { buildSmokeSeed } = await import("../../scripts/make-smoke-seed.mjs");
    const built = buildSmokeSeed() as Record<string, string>;
    const eventsKey = Object.keys(built).find((k) => k.startsWith("cueiq:cache:events:"))!;
    const seeded = JSON.parse(built[eventsKey]);

    const { data } = await supabase
      .from("events")
      .select("*, groups(name, color, exempt_from_deadline)")
      .eq("is_template", false)
      .eq("is_practice", false)
      .order("event_date", { ascending: true });

    expect(data!.map((r) => r.name)).toEqual(seeded.map((r: { name: string }) => r.name));
    expect(data!.map((r) => r.groups.name)).toEqual(
      seeded.map((r: { groups: { name: string } }) => r.groups.name)
    );
  });
});

/** The directory holding both `lib/` and `desktop/` — the repo root, however this
 *  suite was invoked. Throws rather than guessing: a scan rooted at the wrong
 *  directory finds nothing and passes, which is the failure mode worth avoiding in
 *  a test whose whole job is to find something. */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let hops = 0; hops < 8; hops++) {
    if (
      fs.existsSync(path.join(dir, "lib")) &&
      fs.existsSync(path.join(dir, "desktop", "src"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find the repo root above ${process.cwd()}`);
}

describe("it stays a test fixture", () => {
  it("is imported by no module under desktop/src or lib/ except this test", () => {
    // The stub must never become something the app can reach. It has no types, it
    // opens a listening socket at import, and it is a dependency-free .mjs on
    // purpose — an accidental import from a shipped module would take all three
    // into the bundle.
    // Located by walking UP from the cwd to the directory that holds both `lib`
    // and `desktop`, rather than off import.meta.url: vitest rewrites that to a
    // non-file URL under jsdom, and a hardcoded "../../.." breaks the day this
    // file moves.
    const repoRoot = findRepoRoot();
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(entry.name)) continue;
        if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
        if (fs.readFileSync(full, "utf8").includes("smoke-backend")) {
          offenders.push(path.relative(repoRoot, full));
        }
      }
    };

    walk(path.join(repoRoot, "desktop", "src"));
    walk(path.join(repoRoot, "lib"));
    expect(offenders).toEqual([]);
  });
});
