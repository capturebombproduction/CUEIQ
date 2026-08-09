// A LOCAL STUB of the Supabase HTTP API, for the two-phase offline smoke.
//
//   import { SMOKE_WORLD, startSmokeBackend } from "./smoke-backend.mjs";
//   const backend = await startSmokeBackend();      // 127.0.0.1, port 0
//   …point the packaged app's Supabase requests at backend.url…
//   await backend.close();
//
// WHY THIS EXISTS. desktop/scripts/run-smoke.mjs's "airplane" scenario plants an
// expired session AND hand-written `cueiq:cache:*` entries into localStorage, cuts
// the network for real, and asserts the app still reaches a signed-in dashboard
// showing the cached band and the exact cached event count. That proves the offline
// READ path and the boot gate — and its own header says so — but seeding the caches
// BYPASSES the code that writes them. The other half of พี่'s airplane test is the
// half nothing covered: does an ONLINE session actually fill those caches before the
// wifi dies? A cache that is never written is indistinguishable, at the venue, from
// a cache that is never read.
//
// So: stand up a backend the REAL packaged app can sign in to and read from, let it
// write its OWN caches through its own loaders, and only then cut the network. The
// artifact under test does not change — the Supabase URL is baked into the renderer
// bundle at build time, so the Electron main process redirects at the network level
// and this server answers.
//
// ⚠️ IT IS A TEST FIXTURE, NOT A PRODUCT.
//   • plain node:http, zero dependencies, and nothing under desktop/src or lib/ may
//     import it (desktop/src/data/smoke-backend.test.ts asserts that);
//   • it implements the SLICE of PostgREST + GoTrue this app actually uses, and
//     answers a loud 501 for everything else — see UNIMPLEMENTED below for why an
//     empty 200 would be the worst possible default here;
//   • nothing in it is a credential. The password is a fixture string, the JWT is
//     unsigned, the server binds 127.0.0.1 and dies with the smoke.
//
// WHAT IS DELIBERATELY *NOT* SERVED, and why that is safe: `staff_contacts`,
// `song_markers` and `practice_songs` are read by the crew and practice screens,
// which the smoke's boot path never opens. If a future scenario does open them the
// 501 names the table, which is exactly the signal wanted — far better than an
// empty list that would let the smoke pass on a screen this file never served.
import http from "node:http";

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

// Ids are the SAME ids desktop/scripts/make-smoke-seed.mjs builds its offline seed
// from, so the two halves of the airplane test describe one world and an assertion
// written against either holds for the other. Not imported from there on purpose:
// that file is the seed builder and this is a server; a one-way dependency between
// two fixtures is a knot, and the agreement is checked instead — in 50ms, by
// desktop/src/data/smoke-backend.test.ts, which imports BOTH and compares them.
const USER_ID = "00000000-0000-4000-8000-000000000001";
const TENANT_ID = "00000000-0000-4000-8000-000000000011";
const GROUP_ID = "00000000-0000-4000-8000-000000000021";
const EVENT_1 = "00000000-0000-4000-8000-000000000031";
const EVENT_2 = "00000000-0000-4000-8000-000000000032";
const EVENT_TEMPLATE = "00000000-0000-4000-8000-000000000033";

const T0 = "2026-01-01T00:00:00.000Z";

/** The label name the smoke reads off the dashboard. Same value, same NAME, as
 *  make-smoke-seed.mjs exports — assert against either. */
export const SMOKE_TENANT_NAME = "Smoke Label";

/** How many shows the dashboard must list. Deliberately NOT `events.length`: the
 *  fixture also holds a template event, which loadEventsList filters out with
 *  `is_template=eq.false`. If the stub's eq filter ever stopped filtering, the
 *  smoke would see three shows where it demands two — which is the point of
 *  keeping a row in the table that must never be listed. */
export const SMOKE_EVENT_COUNT = 2;

const event = ({ id, name, date, isTemplate = false }) => ({
  id,
  tenant_id: TENANT_ID,
  group_id: GROUP_ID,
  name,
  event_date: date,
  venue: "Smoke Venue",
  event_type: "live_band",
  show_start_time: "19:00:00",
  hard_out_time: "21:00:00",
  status: "approved",
  notes: null,
  map_url: null,
  costume_theme: null,
  share_token: null,
  share_expires_at: null,
  deadline: null,
  deadline_note: null,
  last_run_seconds: null,
  last_run_at: null,
  is_template: isTemplate,
  is_practice: false,
  created_by: USER_ID,
  created_at: T0,
  updated_at: T0,
});

const member = (n, name, nickname, mic) => ({
  id: `00000000-0000-4000-8000-00000000004${n}`,
  tenant_id: TENANT_ID,
  group_id: GROUP_ID,
  name,
  nickname,
  mic_number: mic,
  color: null,
  sort_order: n - 1,
  created_at: T0,
});

const song = (n, title, over = {}) => ({
  id: `00000000-0000-4000-8000-00000000005${n}`,
  tenant_id: TENANT_ID,
  group_id: GROUP_ID,
  title,
  file_name: null,
  duration_seconds: 210,
  language: "th",
  category: null,
  copyright_status: "cleared",
  notes: null,
  audio_path: null,
  audio_name: null,
  audio_expires_at: null,
  bpm: 128,
  created_at: T0,
  updated_at: T0,
  ...over,
});

const scheduleItem = (n, eventId, kind, start, end, sortOrder) => ({
  id: `00000000-0000-4000-8000-00000000006${n}`,
  tenant_id: TENANT_ID,
  event_id: eventId,
  kind,
  label: null,
  location: "Smoke Venue",
  start_time: start,
  end_time: end,
  notes: null,
  sort_order: sortOrder,
});

const setlistItem = (n, { kind, title, seconds, songId = null, sortOrder }) => ({
  id: `00000000-0000-4000-8000-00000000007${n}`,
  tenant_id: TENANT_ID,
  event_id: EVENT_1,
  kind,
  title,
  duration_seconds: seconds,
  buffer_before_seconds: 0,
  buffer_after_seconds: 0,
  mic_slots: [],
  notes: null,
  sort_order: sortOrder,
  song_id: songId,
  audio_path: null,
  audio_name: null,
  loop_audio: false,
});

const micAssignment = (n, micNumber, holder) => ({
  id: `00000000-0000-4000-8000-00000000008${n}`,
  tenant_id: TENANT_ID,
  event_id: EVENT_1,
  mic_number: micNumber,
  holder_name: holder,
  order_index: 0,
  created_at: T0,
});

const runSeq = (n, { name, date, sortOrder, title, kind, start, end, linked = null }) => ({
  id: `00000000-0000-4000-8000-0000000000a${n}`,
  tenant_id: TENANT_ID,
  event_name: name,
  event_date: date,
  sort_order: sortOrder,
  title,
  kind,
  planned_start: start,
  planned_end: end,
  buffer_seconds: 0,
  linked_event_id: linked,
  actual_start: null,
  actual_end: null,
  status: "pending",
  offset_min: null,
  created_at: T0,
});

const MEMBERS = [
  member(1, "Smoke Vocal", "Vo", 1),
  member(2, "Smoke Guitar", "Gt", 2),
  member(3, "Smoke Drums", "Dr", null),
];

const SONGS = [
  song(1, "Smoke Opener", { audio_path: `${TENANT_ID}/${GROUP_ID}/smoke-opener.mp3`, audio_name: "smoke-opener.mp3" }),
  song(2, "Smoke Closer"),
];

/** The whole world this backend serves, as plain data.
 *
 *  `tables` is keyed exactly as PostgREST paths are (`/rest/v1/<key>`), so adding a
 *  table to the fixture is enough to make it readable — there is no second list to
 *  keep in step. Everything else on the object is a convenience for the caller:
 *  the ids and counts a scenario asserts against, gathered in one place so an
 *  assertion never has to reach into `tables` and index a row by position. */
export const SMOKE_WORLD = deepFreeze({
  tenantName: SMOKE_TENANT_NAME,
  eventCount: SMOKE_EVENT_COUNT,
  groupName: "Smoke Band",

  /** What to type into the login box, and what GoTrue will accept.
   *
   *  `loginId` is a full email, so lib/username.ts's loginIdToEmail passes it
   *  through untouched. The bare-username form is accepted as well (a plain
   *  "smoke" becomes smoke@cueiq.local, which is how every real CueIQ account
   *  signs in) — see ACCEPTED_EMAILS. Anything else is a LOUD 400, never a
   *  silently anonymous session. */
  auth: {
    loginId: "smoke@cueiq.invalid",
    email: "smoke@cueiq.invalid",
    password: "smoke-backend-not-a-real-password",
    userId: USER_ID,
    fullName: "Smoke Operator",
  },

  ids: {
    user: USER_ID,
    tenant: TENANT_ID,
    group: GROUP_ID,
    /** The two shows the dashboard must list, in the order the dashboard shows
     *  them (event_date descending). */
    events: [EVENT_2, EVENT_1],
    /** The rich one: setlist, schedule, mic map, lineup. Open THIS to prove an
     *  event page fills its bundle cache. */
    richEvent: EVENT_1,
    /** Present in the table, and must never appear in a dashboard list. */
    templateEvent: EVENT_TEMPLATE,
  },

  tables: {
    tenants: [
      {
        id: TENANT_ID,
        name: SMOKE_TENANT_NAME,
        slug: "smoke",
        logo_url: null,
        created_at: T0,
      },
    ],

    // Label-wide admin: one tenant_members row, no per-band group_roles. That is
    // what makes every group in the workspace viewable, which is in turn what
    // decides the events cache key the offline half asserts on.
    tenant_members: [
      {
        id: "00000000-0000-4000-8000-0000000000b1",
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        role: "admin",
        created_at: T0,
      },
    ],
    group_roles: [],

    groups: [
      {
        id: GROUP_ID,
        tenant_id: TENANT_ID,
        name: "Smoke Band",
        color: "#A62A1C",
        skin: null,
        exempt_from_deadline: false,
        self_photo: false,
        contact_name: null,
        contact_phone: null,
        created_at: T0,
      },
    ],

    events: [
      event({ id: EVENT_1, name: "Smoke Show 1", date: "2026-12-01" }),
      event({ id: EVENT_2, name: "Smoke Show 2", date: "2026-12-02" }),
      event({ id: EVENT_TEMPLATE, name: "Smoke Template", date: null, isTemplate: true }),
    ],

    schedule_items: [
      scheduleItem(1, EVENT_1, "on_location", "16:00:00", null, 0),
      scheduleItem(2, EVENT_1, "sound_check", "17:00:00", "17:30:00", 1),
      scheduleItem(3, EVENT_1, "stage", "19:00:00", "19:40:00", 2),
      scheduleItem(4, EVENT_2, "stage", "20:00:00", "20:40:00", 0),
    ],

    setlist_items: [
      setlistItem(1, { kind: "song", title: "Smoke Opener", seconds: 210, songId: SONGS[0].id, sortOrder: 0 }),
      setlistItem(2, { kind: "mc", title: "MC 1", seconds: 90, sortOrder: 1 }),
      setlistItem(3, { kind: "song", title: "Smoke Closer", seconds: 240, songId: SONGS[1].id, sortOrder: 2 }),
    ],

    mic_assignments: [micAssignment(1, 1, "Smoke Vocal"), micAssignment(2, 2, "Smoke Guitar")],

    members: MEMBERS,
    songs: SONGS,

    event_members: [
      {
        id: "00000000-0000-4000-8000-000000000091",
        tenant_id: TENANT_ID,
        event_id: EVENT_1,
        member_id: MEMBERS[0].id,
        created_at: T0,
      },
      {
        id: "00000000-0000-4000-8000-000000000092",
        tenant_id: TENANT_ID,
        event_id: EVENT_1,
        member_id: MEMBERS[1].id,
        created_at: T0,
      },
    ],

    // Two rows on a DATED festival plus one on a dateless one. The dateless row is
    // not decoration: ~/data/run-order.ts switches between `event_date=eq.<date>`
    // and `event_date=is.null` depending on the festival, and a fixture with no
    // null-dated row would let a broken `is.` filter answer [] and look correct.
    run_sequence: [
      runSeq(1, {
        name: "Smoke Show 1",
        date: "2026-12-01",
        sortOrder: 0,
        title: "Smoke Band",
        kind: "band",
        start: "19:00:00",
        end: "19:40:00",
        linked: EVENT_1,
      }),
      runSeq(2, {
        name: "Smoke Show 1",
        date: "2026-12-01",
        sortOrder: 1,
        title: "Closing",
        kind: "ceremony",
        start: "19:40:00",
        end: "20:00:00",
      }),
      runSeq(3, {
        name: "Smoke Dateless",
        date: null,
        sortOrder: 0,
        title: "Dateless Slot",
        kind: "other",
        start: null,
        end: null,
      }),
    ],
  },
});

/** Login ids GoTrue will authenticate. The second is what the app sends when the
 *  operator types the bare username "smoke" (lib/username.ts appends the internal
 *  domain), so both spellings of the same account work and neither one silently
 *  produces an anonymous client. */
const ACCEPTED_EMAILS = new Set([SMOKE_WORLD.auth.email, "smoke@cueiq.local"]);

// ---------------------------------------------------------------------------
// PostgREST: the slice this app speaks
// ---------------------------------------------------------------------------

/** Embedded resources the app asks for, as PostgREST would resolve them from the
 *  foreign keys. Only `events -> groups` exists today (the dashboard's
 *  `*, groups(name, color, exempt_from_deadline)` and the event page's
 *  `*, groups(*)`); anything else is a 501 that names what was asked for. */
const RELATIONSHIPS = {
  events: {
    groups: { table: "groups", localKey: "group_id", foreignKey: "id", toOne: true },
  },
};

/** A fault we want to answer with a specific status + PostgREST-shaped body. */
class RestFault extends Error {
  constructor(status, body) {
    super(body.message ?? "rest fault");
    this.status = status;
    this.body = body;
  }
}

const unimplemented = (what, hint) =>
  new RestFault(501, {
    code: "SMOKE_UNIMPLEMENTED",
    message: `smoke-backend does not implement ${what}`,
    details: null,
    hint,
  });

/** Split on top-level commas, ignoring commas inside parens or double quotes. */
function splitTopLevel(input) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts.filter((p) => p.length > 0);
}

/**
 * `select=` into { columns, embeds }.
 *
 * postgrest-js has already stripped every unquoted space by the time this arrives.
 * Aliases (`alias:col`), casts (`col::type`) and hints (`table!inner`) are NOT
 * supported and raise a 501 rather than being dropped: the app uses none of them
 * today, and silently ignoring one would hand back a row shaped differently from
 * the one production returns.
 */
function parseSelect(select) {
  const columns = [];
  const embeds = [];
  for (const token of splitTopLevel(select)) {
    const open = token.indexOf("(");
    if (open === -1) {
      if (/[:!]/.test(token)) {
        throw unimplemented(
          `the select token "${token}"`,
          "aliases (alias:col), casts (col::type) and hints (!inner) are not supported"
        );
      }
      columns.push(token);
      continue;
    }
    if (!token.endsWith(")")) {
      throw new RestFault(400, {
        code: "PGRST100",
        message: `unexpected select syntax: ${token}`,
        details: null,
        hint: null,
      });
    }
    const name = token.slice(0, open);
    if (/[:!]/.test(name)) {
      throw unimplemented(
        `the embedded select "${name}"`,
        "aliases and !inner hints on embedded resources are not supported"
      );
    }
    embeds.push({ name, select: token.slice(open + 1, -1) });
  }
  return { columns, embeds };
}

/** Project a row onto the requested column list (`*` = every column).
 *
 *  An EMPTY list yields an empty object rather than the whole row: that is the
 *  `select=groups(name)` case, where PostgREST returns the embed alone. Nothing
 *  under desktop/src asks for it today — but "no columns means all columns" is the
 *  kind of convenient guess that makes a stub answer richer than production and
 *  hides a caller reading a field it never selected. */
function project(table, row, columns) {
  if (columns.includes("*")) return { ...row };
  const out = {};
  for (const column of columns) {
    if (!(column in row)) {
      // Faithful to PostgREST, and deliberately loud: a column the fixture does
      // not carry is a fixture that has drifted from the schema, and answering
      // `undefined` would let the app cache a row with a missing field.
      throw new RestFault(400, {
        code: "42703",
        message: `column ${table}.${column} does not exist`,
        details: null,
        hint: null,
      });
    }
    out[column] = row[column];
  }
  return out;
}

/** Unwrap PostgREST's optional double quotes around a filter value. */
const unquote = (v) => (v.length > 1 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

/** Row values arrive as text in the query string; compare them as text. */
function asFilterText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** Split the body of `in.(…)`, honouring quoted values that contain commas. */
function splitInList(body) {
  const inner = body.startsWith("(") && body.endsWith(")") ? body.slice(1, -1) : body;
  return inner.length === 0 ? [] : splitTopLevel(inner).map(unquote);
}

/** Query-string keys PostgREST reads as something other than a filter. */
const NON_FILTER_PARAMS = new Set(["select", "order", "limit", "offset"]);

function matchesFilter(row, column, raw) {
  const dot = raw.indexOf(".");
  if (dot === -1) {
    throw unimplemented(`the filter "${column}=${raw}"`, "expected <operator>.<value>");
  }
  const op = raw.slice(0, dot);
  const arg = raw.slice(dot + 1);
  const value = asFilterText(row[column]);
  switch (op) {
    case "eq":
      return value !== null && value === unquote(arg);
    case "in":
      return value !== null && splitInList(arg).includes(value);
    case "is":
      if (arg === "null") return row[column] === null || row[column] === undefined;
      if (arg === "true" || arg === "false") return row[column] === (arg === "true");
      throw unimplemented(`the filter "${column}=is.${arg}"`, "only is.null / is.true / is.false");
    default:
      // eq / in / is are what ~/data/*.ts sends. Anything else would need the
      // real operator semantics, and guessing is how a stub starts lying.
      throw unimplemented(
        `the PostgREST operator "${op}" (on column "${column}")`,
        "supported: eq, in, is"
      );
  }
}

function compareValues(a, b) {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "boolean" || typeof b === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/**
 * Apply `order=col.dir[.nullsfirst|.nullslast][,…]`.
 *
 * Honoured rather than ignored because two callers depend on it in ways that are
 * invisible when it silently does nothing: the dashboard reads its list in
 * event_date-descending order (a wrong order is a screenshot nobody checks), and
 * ~/data/workspace.ts pairs `order(created_at).limit(1)` with maybeSingle — where
 * the wrong first row is the wrong ROLE for the whole session.
 *
 * PostgreSQL's own defaults for unspecified null placement: NULLS LAST for asc,
 * NULLS FIRST for desc.
 */
function applyOrder(rows, orderParam) {
  const keys = splitTopLevel(orderParam).map((spec) => {
    const [column, ...rest] = spec.split(".");
    const ascending = !rest.includes("desc");
    const nullsFirst = rest.includes("nullsfirst")
      ? true
      : rest.includes("nullslast")
        ? false
        : !ascending;
    return { column, ascending, nullsFirst };
  });
  // Index-tagged so equal keys keep their fixture order — Array#sort is stable in
  // modern V8, but a fixture whose meaning depends on that is a fixture waiting to
  // be surprised by a different runtime.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      for (const { column, ascending, nullsFirst } of keys) {
        const a = left.row[column] ?? null;
        const b = right.row[column] ?? null;
        if (a === null && b === null) continue;
        if (a === null) return nullsFirst ? -1 : 1;
        if (b === null) return nullsFirst ? 1 : -1;
        const cmp = compareValues(a, b);
        if (cmp !== 0) return ascending ? cmp : -cmp;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.row);
}

/**
 * Resolve one `GET /rest/v1/<table>?…` against the fixture.
 *
 * Ignored on purpose, with the reason each one is safe:
 *   • the `Range` header — postgrest-js only sets it for `.range()`, which no
 *     module under desktop/src/data calls, so honouring it could not change what
 *     the app sees. `limit` and `offset` ARE honoured, and those are what
 *     `.limit()` actually sends.
 *   • `Prefer: count=…` — likewise unused by the read paths. A `Content-Range` is
 *     still sent so a caller that starts asking gets a well-formed header rather
 *     than a missing one.
 */
function runQuery(world, table, params) {
  const rows = world.tables[table];
  if (!rows) {
    throw unimplemented(`the table "${table}"`, `known tables: ${Object.keys(world.tables).join(", ")}`);
  }

  const { columns, embeds } = parseSelect(params.get("select") ?? "*");

  let out = rows.filter((row) =>
    [...params.entries()].every(([key, raw]) =>
      NON_FILTER_PARAMS.has(key) ? true : matchesFilter(row, key, raw)
    )
  );

  const order = params.get("order");
  if (order) out = applyOrder(out, order);

  const offset = Number.parseInt(params.get("offset") ?? "", 10);
  if (Number.isFinite(offset)) out = out.slice(offset);
  const limit = Number.parseInt(params.get("limit") ?? "", 10);
  if (Number.isFinite(limit)) out = out.slice(0, limit);

  return out.map((row) => {
    const projected = project(table, row, columns);
    for (const embed of embeds) {
      const rel = RELATIONSHIPS[table]?.[embed.name];
      if (!rel) {
        throw unimplemented(
          `the embedded resource "${table} -> ${embed.name}"`,
          "add it to RELATIONSHIPS in desktop/scripts/smoke-backend.mjs"
        );
      }
      const related = (world.tables[rel.table] ?? []).filter(
        (candidate) => candidate[rel.foreignKey] === row[rel.localKey]
      );
      const { columns: embedColumns } = parseSelect(embed.select || "*");
      const projectedRelated = related.map((r) => project(rel.table, r, embedColumns));
      projected[embed.name] = rel.toOne ? (projectedRelated[0] ?? null) : projectedRelated;
    }
    return projected;
  });
}

// ---------------------------------------------------------------------------
// GoTrue: real-SHAPED sessions
// ---------------------------------------------------------------------------

const b64url = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/**
 * A three-segment JWT whose payload carries what supabase-js and the app read.
 *
 * The signature is a fixed string, not a signature — nothing here verifies one,
 * and a real one would mean this file held a real key. What DOES matter is the
 * shape: ~/data/stored-session.ts and lib/auth-session.ts both parse the stored
 * session, and the offline boot path branches on it.
 */
function mintAccessToken(world, { expiresAt, issuedAt, sessionId }) {
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({
      iss: "smoke-backend",
      sub: world.auth.userId,
      aud: "authenticated",
      role: "authenticated",
      email: world.auth.email,
      session_id: sessionId,
      iat: issuedAt,
      exp: expiresAt,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: { full_name: world.auth.fullName },
    }),
    "smoke-backend-not-a-real-signature",
  ].join(".");
}

function buildUser(world) {
  return {
    id: world.auth.userId,
    aud: "authenticated",
    role: "authenticated",
    email: world.auth.email,
    email_confirmed_at: T0,
    phone: "",
    confirmed_at: T0,
    last_sign_in_at: T0,
    // workspace.ts reads user_metadata.full_name for the display name, and the
    // offline seed's cached workspace carries the same value — keep them equal or
    // the online half writes a cache the offline half would not recognise.
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { full_name: world.auth.fullName },
    identities: [],
    is_anonymous: false,
    created_at: T0,
    updated_at: T0,
  };
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/**
 * Headers that make a file:// renderer's request survive.
 *
 * Chromium gives a file:// document the opaque origin `null` and preflights every
 * request carrying a custom header — and supabase-js sends four of them (`apikey`,
 * `authorization`, `x-client-info`, `x-supabase-api-version`) plus PostgREST's
 * `accept-profile` and `prefer`. Miss the preflight and NOTHING reaches the handler
 * logic below; the app just reports every read as a network failure and quietly
 * serves whatever cache it already had, which for phase one is nothing at all.
 *
 * The allow-origin is echoed rather than `*` so `Origin: null` is answered with
 * `null`, and `content-range` is exposed because postgrest-js reads it for counts.
 */
function corsHeaders(req) {
  return {
    "access-control-allow-origin": req.headers.origin ?? "*",
    vary: "Origin",
    "access-control-allow-methods": "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers":
      req.headers["access-control-request-headers"] ??
      "authorization, apikey, content-type, x-client-info, x-supabase-api-version, accept-profile, content-profile, prefer, range, accept",
    "access-control-expose-headers": "content-range, content-location, x-supabase-api-version",
    "access-control-max-age": "86400",
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** First value per key — Object.fromEntries(searchParams) keeps the LAST, which is
 *  the wrong one for a protocol that expresses repeated filters as repeated keys. */
function firstValues(searchParams) {
  const out = {};
  for (const [key, value] of searchParams.entries()) if (!(key in out)) out[key] = value;
  return out;
}

/**
 * Start the stub.
 *
 * @param {object} [options]
 * @param {number} [options.port=0]        0 = an ephemeral port, so parallel runs cannot collide.
 * @param {object} [options.world]         a fixture in SMOKE_WORLD's shape.
 * @param {number} [options.latencyMs=0]   artificial delay before every response.
 * @param {number} [options.sessionTtlSeconds=3600]  access-token lifetime.
 * @param {boolean} [options.requireAuth=true]  see the note on SMOKE_ANON below.
 * @returns {Promise<{url: string, requests: object[], close: () => Promise<void>}>}
 */
export async function startSmokeBackend(options = {}) {
  const {
    port = 0,
    world = SMOKE_WORLD,
    latencyMs = 0,
    sessionTtlSeconds = 3600,
    requireAuth = true,
  } = options;

  /** Every request, in order: { method, path, query, search, params, authorized, status }.
   *  `query` holds the FIRST value of each key (what an assertion almost always
   *  wants); `params` keeps the full [key, value] list, because PostgREST puts two
   *  filters on one column in two entries with the same name — and
   *  Object.fromEntries would keep only the last of those. */
  const requests = [];
  /** Paths that answered 501, gathered separately so a scenario can fail on
   *  "the app asked for something this stub never served" without scanning. */
  const unimplementedPaths = [];

  const accessTokens = new Set();
  const refreshTokens = new Set();
  let sessionCounter = 0;

  function issueSession() {
    sessionCounter += 1;
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + sessionTtlSeconds;
    const sessionId = `smoke-session-${sessionCounter}`;
    const accessToken = mintAccessToken(world, { expiresAt, issuedAt, sessionId });
    const refreshToken = `smoke-refresh-${sessionCounter}`;
    accessTokens.add(accessToken);
    refreshTokens.add(refreshToken);
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: sessionTtlSeconds,
      expires_at: expiresAt,
      refresh_token: refreshToken,
      user: buildUser(world),
    };
  }

  const bearerOf = (req) => {
    const header = req.headers.authorization ?? "";
    return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const record = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: firstValues(url.searchParams),
      search: url.search,
      params: [...url.searchParams.entries()],
      authorized: false,
      status: 0,
    };
    requests.push(record);

    const send = (status, body, extraHeaders = {}) => {
      record.status = status;
      if (status === 501) unimplementedPaths.push(`${record.method} ${record.path}`);
      const payload = body === null ? "" : JSON.stringify(body);
      res.writeHead(status, {
        ...corsHeaders(req),
        ...(payload ? JSON_HEADERS : {}),
        // GoTrue stamps this, and auth-js reads it to decide whether an error
        // body's `code` field is authoritative. Without it a 400 from this stub
        // would surface with no error code at all.
        "x-supabase-api-version": "2024-01-01",
        ...extraHeaders,
      });
      res.end(req.method === "HEAD" ? undefined : payload);
    };

    try {
      if (latencyMs > 0) await sleep(latencyMs);

      // Preflight. Answered for EVERY path, including ones that will 501 — a
      // preflight failure and a 501 look identical from the renderer, and only
      // one of them names what is missing.
      if (req.method === "OPTIONS") {
        record.status = 204;
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }

      // ── GoTrue ───────────────────────────────────────────────────────────
      if (url.pathname === "/auth/v1/token" && req.method === "POST") {
        const grant = url.searchParams.get("grant_type");
        const body = JSON.parse((await readBody(req)) || "{}");

        if (grant === "password") {
          const email = String(body.email ?? "").trim().toLowerCase();
          const ok = ACCEPTED_EMAILS.has(email) && body.password === world.auth.password;
          if (!ok) {
            send(400, {
              code: "invalid_credentials",
              error_code: "invalid_credentials",
              msg: `Invalid login credentials (smoke-backend expects ${world.auth.email})`,
            });
            return;
          }
          record.authorized = true;
          send(200, issueSession());
          return;
        }

        if (grant === "refresh_token") {
          const presented = body.refresh_token;
          if (!refreshTokens.has(presented)) {
            send(400, {
              code: "refresh_token_not_found",
              error_code: "refresh_token_not_found",
              msg: "Invalid Refresh Token: Refresh Token Not Found",
            });
            return;
          }
          // Rotate, like GoTrue does: a replayed refresh token must fail, or the
          // stub would hide a client that never stores the new one.
          refreshTokens.delete(presented);
          record.authorized = true;
          send(200, issueSession());
          return;
        }

        send(501, {
          code: "SMOKE_UNIMPLEMENTED",
          message: `smoke-backend does not implement grant_type=${grant}`,
          path: url.pathname,
        });
        return;
      }

      if (url.pathname === "/auth/v1/user" && (req.method === "GET" || req.method === "HEAD")) {
        const token = bearerOf(req);
        if (!token || !accessTokens.has(token)) {
          send(401, { code: "bad_jwt", error_code: "bad_jwt", msg: "invalid JWT: unrecognised token" });
          return;
        }
        record.authorized = true;
        send(200, buildUser(world));
        return;
      }

      if (url.pathname === "/auth/v1/logout" && req.method === "POST") {
        const token = bearerOf(req);
        record.authorized = Boolean(token && accessTokens.has(token));
        accessTokens.clear();
        refreshTokens.clear();
        record.status = 204;
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }

      // ── PostgREST ────────────────────────────────────────────────────────
      if (url.pathname.startsWith("/rest/v1/")) {
        const table = url.pathname.slice("/rest/v1/".length);
        const token = bearerOf(req);
        record.authorized = Boolean(token && accessTokens.has(token));

        if (req.method !== "GET" && req.method !== "HEAD") {
          send(501, {
            code: "SMOKE_UNIMPLEMENTED",
            message: `smoke-backend serves reads only; got ${req.method} ${url.pathname}`,
            details: null,
            hint: "the offline smoke fills caches by READING; add a writer here if a scenario needs one",
          });
          return;
        }

        // THE ANON TRAP, made loud. supabase-js does not fail when it has no
        // session — SupabaseClient._getAccessToken quietly falls back to the anon
        // key, and real RLS answers that with an empty list and NO error. That is
        // exactly how the packaged app shipped once (every read ran as anon under
        // file://), and it is exactly what this project's own invariant warns
        // about: an empty read is not an empty table. A fixture that imitated RLS
        // here would let the smoke "pass" with every cache written empty, so it
        // refuses by name instead.
        if (requireAuth && !record.authorized) {
          send(401, {
            code: "SMOKE_ANON",
            message:
              `smoke-backend refused an unauthenticated read of "${table}": the request ` +
              "carried no session token (production RLS would have answered [] with no error)",
            details: null,
            hint: "sign in first; if sign-in succeeded, the Authorization header is being dropped on the way here",
          });
          return;
        }

        const rows = runQuery(world, table, url.searchParams);

        // `.single()` (and anything else asking for the object media type) must get
        // ONE object, or a 406/PGRST116. Getting this wrong is the likeliest way a
        // stub silently diverges: an array where the client expected an object
        // reads as a corrupt row rather than as a missing one.
        const accept = String(req.headers.accept ?? "");
        if (accept.includes("application/vnd.pgrst.object+json")) {
          if (rows.length !== 1) {
            send(406, {
              code: "PGRST116",
              details: `Results contain ${rows.length} rows, application/vnd.pgrst.object+json requires 1 row`,
              hint: null,
              message: "JSON object requested, multiple (or no) rows returned",
            });
            return;
          }
          send(200, rows[0], { "content-range": "0-0/*" });
          return;
        }

        send(200, rows, {
          "content-range": rows.length === 0 ? "*/*" : `0-${rows.length - 1}/*`,
        });
        return;
      }

      // ── everything else ──────────────────────────────────────────────────
      send(501, {
        code: "SMOKE_UNIMPLEMENTED",
        message: `smoke-backend has no handler for ${req.method} ${url.pathname}`,
        details: null,
        hint: "implement it in desktop/scripts/smoke-backend.mjs, or stop the app from calling it",
      });
    } catch (err) {
      if (err instanceof RestFault) {
        send(err.status, err.body);
        return;
      }
      // A bug in this file must never read as a backend that answered nothing.
      send(500, {
        code: "SMOKE_BACKEND_CRASH",
        message: String(err?.stack ?? err),
        details: null,
        hint: null,
      });
    }
  });

  // Realtime. supabase-js opens a WebSocket for any subscribed channel; there is
  // no realtime here, so refuse the upgrade immediately and RECORD it rather than
  // letting the socket hang. The client treats it as a dropped connection and
  // retries, which is harmless — but an unrecorded one would be invisible.
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({
      method: "UPGRADE",
      path: url.pathname,
      query: firstValues(url.searchParams),
      search: url.search,
      params: [...url.searchParams.entries()],
      authorized: false,
      status: 501,
    });
    socket.destroy();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  let closing = null;
  return {
    url,
    requests,
    unimplementedPaths,
    world,
    /** Resolves once the listener AND every keep-alive socket are gone. Without
     *  closeAllConnections() a client that kept a connection open (supabase-js
     *  does) leaves server.close() pending until its idle timeout, which reads as
     *  a hung test run. */
    close() {
      if (!closing) {
        closing = new Promise((resolve, reject) => {
          server.closeAllConnections?.();
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
      return closing;
    },
  };
}
