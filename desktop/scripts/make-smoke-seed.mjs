// Builds the localStorage seed for the OFFLINE self-test of the packaged app.
//
//   node desktop/scripts/make-smoke-seed.mjs <out.json>
//
// The packaged .exe is then launched with CUEIQ_SMOKE_SEED_FILE pointing at that
// file, CUEIQ_SMOKE_OFFLINE=1 and CUEIQ_SMOKE_EXPECT=signed-in — which reproduces
// the one condition CI never tested and พี่ has to fly to a venue to find: a
// laptop cold-booting with an expired session and no internet.
//
// ⚠️ NOTHING HERE IS A CREDENTIAL. The token is unsigned and long expired, the user
// id is a fixed all-zeros-ish uuid, and the whole point is that the network is cut
// so it is never presented to anything. It grants nothing: RLS is server-side, and
// an offline boot only ever shows what is already cached on that machine.
//
// Kept as a script rather than a heredoc inside the workflow because its shape has
// to agree with desktop/src/data/stored-session.ts — and that agreement is checked
// by a unit test (desktop/src/data/stored-session.test.ts), so a drift fails in
// seconds instead of twenty minutes into a release build.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** Default project ref, matching desktop/vite.config.ts's baked-in Supabase URL.
 *  The ref only decides whether supabase-js ITSELF recognises the entry: with the
 *  real ref it finds the session, tries to refresh, fails on the cut network and
 *  answers null — the true venue sequence. With a stale ref it simply never looks,
 *  and the app's own stored-session scan opens the offline pass anyway. The test is
 *  meaningful either way, but the real ref is the faithful one. */
const DEFAULT_PROJECT_REF = "kewyqqxohckurwuepucv";

const b64url = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");

/** What the seeded machine "remembers" — asserted by name and by count in the
 *  smoke, so a cache the app fails to read shows up as a specific mismatch rather
 *  than as a vaguely emptier screen. */
export const SMOKE_TENANT_NAME = "Smoke Label";
export const SMOKE_EVENT_COUNT = 2;

export function buildSmokeSeed({
  projectRef = DEFAULT_PROJECT_REF,
  userId = "00000000-0000-4000-8000-000000000001",
  email = "smoke@cueiq.invalid",
  tenantId = "00000000-0000-4000-8000-000000000011",
  groupId = "00000000-0000-4000-8000-000000000021",
  // Expired hours ago, which is exactly the state of a laptop last online before
  // the drive to the venue. auth-js reads expires_at, not the token's own claims,
  // but a syntactically valid JWT keeps every other code path on its normal branch.
  expiresAt = 1700000000,
} = {}) {
  const accessToken = [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({ sub: userId, email, role: "authenticated", exp: expiresAt, aud: "authenticated" }),
    "not-a-real-signature",
  ].join(".");

  const group = {
    id: groupId,
    tenant_id: tenantId,
    name: "Smoke Band",
    color: "#A62A1C",
    skin: null,
    exempt_from_deadline: false,
    self_photo: false,
    contact_name: null,
    contact_phone: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };

  // ⚠️ This key is DERIVED, not invented: ~/data/events-list.ts builds
  // `events:<tenantId>:<viewable group ids, sorted, comma-joined>`, and the viewable
  // set comes from permissions. An "admin" tenant role is label-wide, so it sees
  // every group in the workspace — here, the one below. Get this wrong and the app
  // boots perfectly and shows zero shows, which is exactly the failure the smoke's
  // exact-count assertion exists to catch.
  const eventsKey = `cueiq:cache:events:${tenantId}:${[group.id].sort().join(",")}`;

  const event = (n, date) => ({
    id: `00000000-0000-4000-8000-00000000003${n}`,
    tenant_id: tenantId,
    group_id: group.id,
    name: `Smoke Show ${n}`,
    event_date: date,
    venue: "Smoke Venue",
    status: "approved",
    is_template: false,
    is_practice: false,
    created_at: "2026-01-01T00:00:00.000Z",
    groups: { name: group.name, color: group.color, exempt_from_deadline: false },
  });

  return {
    [`sb-${projectRef}-auth-token`]: JSON.stringify({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: expiresAt,
      refresh_token: "smoke-refresh-token",
      user: {
        id: userId,
        aud: "authenticated",
        role: "authenticated",
        email,
        app_metadata: {},
        user_metadata: {},
        created_at: "2026-01-01T00:00:00.000Z",
      },
    }),
    // ~/data/workspace.ts only serves this when cached.user.id === the stored
    // session's id — the shared-band-device owner check. The two ids MUST agree.
    "cueiq:cache:workspace": JSON.stringify({
      user: { id: userId, email, name: "Smoke Operator" },
      membership: { tenant_id: tenantId, role: "admin" },
      tenant: {
        id: tenantId,
        name: SMOKE_TENANT_NAME,
        slug: "smoke",
        logo_url: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      groups: [group],
      groupRoles: [],
      perms: { tenantRole: "admin", groupRoles: [] },
    }),
    [eventsKey]: JSON.stringify([event(1, "2026-12-01"), event(2, "2026-12-02")]),
  };
}

// CLI: only when run directly, so the unit test can import the builder. pathToFileURL
// rather than string-building a file:// URL — on Windows the drive letter and the
// backslashes make the hand-rolled version silently never match.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: node make-smoke-seed.mjs <out.json>");
    process.exit(2);
  }
  fs.writeFileSync(out, JSON.stringify(buildSmokeSeed(), null, 2), "utf8");
  console.log(`wrote smoke seed to ${out}`);
}
