/* eslint-disable @typescript-eslint/no-explicit-any */
// Shared test doubles for the ONE seam every CueIQ screen goes through:
// createClient() from "@/lib/supabase/client".
//
// These are shaped from the real call sites, not from a generic supabase mock.
// The four shapes that actually matter here, and why each exists:
//
//  • makeQueryFake()  — the BUILDER ITSELF is thenable, not just its terminal
//    calls. desktop/src/pages/crew.tsx does
//        createClient().from("staff_contacts").select("*").eq(...).order(...).then(...)
//    — no .single(), no await on a terminal. A fake whose .order() returns a
//    non-thenable leaves that page on "กำลังโหลด…" for ever and the test times
//    out pointing at the component. Every stage of every chain resolves.
//    It also records `selectAfterWrite`, because the repo's central write rule
//    ("a write that reported no error but touched no row did not happen",
//    lib/write-guard.ts) is only enforceable when the write asks for its rows
//    back — `.update(p).eq("id", id).select("id")`. A test needs to assert the
//    .select() is there, not just that an update was sent.
//
//  • makeChannelFake() — two-device handoff without a second browser. Live Mode,
//    the setlist builder and the festival show-caller all coordinate over
//    broadcast on a private channel (lib/realtime.ts privateChannel is a thin
//    wrapper over supabase.channel, so mocking the client covers it). The fake
//    keeps every .on() handler in a registry the test invokes directly, and hands
//    the .subscribe(cb) status callback back so a test can fire "SUBSCRIBED" or
//    "CHANNEL_ERROR" itself. Nothing fires on its own: a transition a test did
//    not cause is a transition that will race on a loaded CI box.
//    channel() also REUSES an open channel for the same topic, exactly like
//    RealtimeClient does — desktop/src/data/mgmt-outbox.ts depends on that
//    (getChannels().find(c => c.topic === `realtime:${topic}`)), and the bug it
//    guards against (subscribe() on an already-open channel never runs its join
//    callback, so the broadcast vanishes silently) only reproduces with reuse.
//
//  • makeAuthFake() — getSession()/getUser() are how the app answers "was that
//    empty read really empty, or did we go out as anon?" (lib/auth-session.ts).
//    It can also HANG: desktop/src/App.tsx has a boot timer whose whole purpose
//    is a getSession() that never settles on a dead venue network, and the only
//    way to test that path is a promise that genuinely never resolves — then
//    release() it late, because App.tsx promises a late answer still upgrades
//    the state.
//
//  • instrumentMediaElements() — opt-in, per test. Live Mode builds its two
//    <audio> elements with `new Audio()` inside an effect and keeps them on refs;
//    they are never in the document, so no DOM query can find them. The
//    instrumentation is therefore prototype-level, with per-instance state, and
//    the returned handle gives the elements back in creation order so a test can
//    tell the primary from the secondary during a crossfade pre-roll.
//
// Nothing in this file registers global hooks (except an opt-out-able
// onTestFinished inside instrumentMediaElements, which patches prototypes and so
// must not leak into the next file). Importing it changes no behaviour.
import { vi, onTestFinished, type Mock } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Results and scripts
// ─────────────────────────────────────────────────────────────────────────────

export interface PostgrestErrorLike {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

/** The shape every awaited postgrest chain resolves to. `status` is on it because
 *  the app classifies failures by HTTP status, not by the error's prose — see
 *  lib/mgmt-outbox.ts isQueueableWriteError (status 0 = transport failure). */
export interface QueryResult<T = any> {
  data: T;
  error: PostgrestErrorLike | null;
  status: number;
  statusText: string;
  count: number | null;
}

/** What a script entry may declare. Anything omitted is filled in sensibly:
 *  data defaults to [] (or null when an error is present), status to 200/400,
 *  count to data.length when the call asked for one. */
export type ScriptResult = Partial<QueryResult>;

/** Full control: decide the result from the recorded call (verb, filters, payload). */
export type ScriptFn = (call: RecordedCall) => ScriptResult | Promise<ScriptResult>;

export type ScriptEntry = ScriptResult | ScriptFn;

/** One entry = that table always answers so. An ARRAY = a queue consumed in
 *  order, whose LAST entry then repeats for every further call. */
export type TableScript = ScriptEntry | ScriptEntry[];

/** Keyed by table name. `"*"` is the fallback for tables with no entry.
 *  An rpc is scripted under `"rpc:<function_name>"`. */
export type QueryScript = Record<string, TableScript>;

/** Rows came back fine. `ok([])` is a genuinely empty table. */
export function ok<T = any>(data: T, extra: ScriptResult = {}): ScriptResult {
  return { data, error: null, status: 200, ...extra };
}

/** A real server rejection: the request arrived and was refused. Default 400 —
 *  the app must NOT queue these for replay. */
export function fail(
  message: string,
  status = 400,
  extra: ScriptResult = {}
): ScriptResult {
  return { data: null, error: { message }, status, ...extra };
}

/** No response at all — the venue-wifi case. status 0 is what makes the app's
 *  offline classifiers queue the write instead of throwing it away. */
export function offline(message = "TypeError: Failed to fetch"): ScriptResult {
  return { data: null, error: { message }, status: 0 };
}

/** The lie this codebase is built to survive: RLS answers an ANON request with
 *  rows: [] and error: null. Indistinguishable from an empty table unless you
 *  ask auth — see lib/auth-session.ts. */
export function anonEmpty(): ScriptResult {
  return { data: [], error: null, status: 200 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Recording
// ─────────────────────────────────────────────────────────────────────────────

export type PostgrestVerb = "select" | "insert" | "update" | "delete" | "upsert" | "rpc";

export interface RecordedFilter {
  /** "eq" | "in" | "is" | "not" | … */
  op: string;
  column: string;
  value: unknown;
  /** only for .not(column, operator, value) */
  operator?: string;
}

export interface RecordedModifier {
  op: "order" | "limit" | "range";
  args: unknown[];
}

/** One chain, from .from() to the value it resolved to. Pushed into
 *  QueryFake.calls at .from() time and mutated as the chain is built, so a test
 *  can inspect a chain that has not settled yet (see QueryFake.defer). */
export interface RecordedCall {
  table: string;
  verb: PostgrestVerb;
  /** insert/update/upsert payload, or the rpc's args object */
  values: unknown;
  /** options given to the write verb, or to .select() */
  options: Record<string, unknown> | null;
  /** the column list passed to .select() */
  columns: string | null;
  /** TRUE when .select() was chained AFTER .insert()/.update()/.delete()/.upsert().
   *  This is how you assert a write asked for its rows back (write-guard). */
  selectAfterWrite: boolean;
  countRequested: "exact" | "planned" | "estimated" | null;
  head: boolean;
  filters: RecordedFilter[];
  /** convenience view of the .eq() filters: { event_id: "…", id: "…" } */
  eq: Record<string, unknown>;
  modifiers: RecordedModifier[];
  terminal: "single" | "maybeSingle" | null;
  /** true once something awaited / .then()'d this chain */
  awaited: boolean;
  settled: boolean;
  result: QueryResult | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The query builder
// ─────────────────────────────────────────────────────────────────────────────

export interface SelectOptions {
  count?: "exact" | "planned" | "estimated";
  head?: boolean;
  [k: string]: unknown;
}

/** Every method returns the SAME builder, which mirrors how the call sites use
 *  it (`let q = supabase.from(t).update(p).eq("id", id); q = q.is(k, null);
 *  return q.select("id")`) and keeps one recording per chain. */
export interface QueryBuilderFake extends PromiseLike<QueryResult> {
  select(columns?: string, options?: SelectOptions): QueryBuilderFake;
  insert(values: unknown, options?: Record<string, unknown>): QueryBuilderFake;
  update(values: unknown, options?: Record<string, unknown>): QueryBuilderFake;
  upsert(values: unknown, options?: Record<string, unknown>): QueryBuilderFake;
  delete(options?: Record<string, unknown>): QueryBuilderFake;

  eq(column: string, value: unknown): QueryBuilderFake;
  neq(column: string, value: unknown): QueryBuilderFake;
  gt(column: string, value: unknown): QueryBuilderFake;
  gte(column: string, value: unknown): QueryBuilderFake;
  lt(column: string, value: unknown): QueryBuilderFake;
  lte(column: string, value: unknown): QueryBuilderFake;
  like(column: string, value: unknown): QueryBuilderFake;
  ilike(column: string, value: unknown): QueryBuilderFake;
  is(column: string, value: unknown): QueryBuilderFake;
  in(column: string, value: readonly unknown[]): QueryBuilderFake;
  contains(column: string, value: unknown): QueryBuilderFake;
  overlaps(column: string, value: unknown): QueryBuilderFake;
  match(query: Record<string, unknown>): QueryBuilderFake;
  not(column: string, operator: string, value: unknown): QueryBuilderFake;
  or(filters: string, options?: Record<string, unknown>): QueryBuilderFake;
  filter(column: string, operator: string, value: unknown): QueryBuilderFake;

  order(column: string, options?: Record<string, unknown>): QueryBuilderFake;
  limit(count: number, options?: Record<string, unknown>): QueryBuilderFake;
  range(from: number, to: number, options?: Record<string, unknown>): QueryBuilderFake;
  abortSignal(signal: AbortSignal): QueryBuilderFake;
  throwOnError(): QueryBuilderFake;
  returns<T>(): QueryBuilderFake;
  overrideTypes<T>(): QueryBuilderFake;

  /** Reduces an array result to its first row (null when empty), like postgrest. */
  maybeSingle(): QueryBuilderFake;
  /** Like postgrest: 0 or >1 rows becomes a PGRST116 error, not a row. */
  single(): QueryBuilderFake;

  then<TR1 = QueryResult, TR2 = never>(
    onfulfilled?: ((value: QueryResult) => TR1 | PromiseLike<TR1>) | undefined | null,
    onrejected?: ((reason: any) => TR2 | PromiseLike<TR2>) | undefined | null
  ): Promise<TR1 | TR2>;
  catch<TR = never>(
    onrejected?: ((reason: any) => TR | PromiseLike<TR>) | undefined | null
  ): Promise<QueryResult | TR>;
  finally(onfinally?: (() => void) | undefined | null): Promise<QueryResult>;

  /** This chain's recording — the same object that is in QueryFake.calls. */
  readonly call: RecordedCall;
}

/** A read held open on purpose. `resolve()` is the ONLY thing that settles it,
 *  so a test can assert the loading state first and then cause the transition. */
export interface DeferredResult {
  /** true once a chain has picked this entry up (i.e. the read is in flight) */
  readonly taken: boolean;
  /** true while it has been taken and not yet settled */
  readonly pending: boolean;
  resolve(result?: ScriptResult): void;
  reject(reason?: unknown): void;
}

export interface QueryFake {
  from(table: string): QueryBuilderFake;
  rpc(fn: string, args?: unknown, options?: Record<string, unknown>): QueryBuilderFake;

  /** Every chain, in the order .from() was called. Mutated in place — never
   *  reassigned — so a destructured reference stays valid across reset(). */
  readonly calls: RecordedCall[];
  callsTo(table: string, verb?: PostgrestVerb): RecordedCall[];
  lastCall(table?: string, verb?: PostgrestVerb): RecordedCall | undefined;
  /** Chains that have not settled yet. */
  pending(): RecordedCall[];

  /** Replace the whole script. */
  setScript(script: QueryScript): void;
  /** Set (or re-set) one table's answers. */
  setTable(table: string, entry: TableScript): void;
  /** Hold a read open until the test settles it. With a table name, the next
   *  call to THAT table (ahead of whatever the script says); with no argument,
   *  the next call to any table at all. */
  defer(table?: string): DeferredResult;
  /** Forget every recorded call; keeps the script. */
  clearCalls(): void;
  /** Forget calls AND restore the script this fake was created with. */
  reset(): void;
}

interface QueueEntry {
  entry: ScriptEntry;
  /** consumed on use (queued entries and defers); the last scripted entry sticks */
  once: boolean;
}

const DEFAULT_ENTRY: ScriptResult = { data: [], error: null, status: 200 };

function toQueue(script: TableScript): QueueEntry[] {
  if (Array.isArray(script)) {
    return script.map((entry, i) => ({ entry, once: i < script.length - 1 }));
  }
  return [{ entry: script, once: false }];
}

function normalize(part: ScriptResult, call: RecordedCall): QueryResult {
  const error = part.error ?? null;
  let data: any = "data" in part ? part.data : error ? null : [];
  const status = part.status ?? (error ? 400 : 200);
  let count: number | null =
    part.count ?? (call.countRequested && Array.isArray(data) ? data.length : null);

  if (!error && call.terminal) {
    if (Array.isArray(data)) {
      if (call.terminal === "maybeSingle") {
        data = data.length ? data[0] : null;
      } else if (data.length === 1) {
        data = data[0];
      } else {
        // postgrest's own answer for .single() with 0 or >1 rows.
        return {
          data: null,
          error: {
            message: "JSON object requested, multiple (or no) rows returned",
            code: "PGRST116",
          },
          status: part.status ?? 406,
          statusText: part.statusText ?? "Not Acceptable",
          count,
        };
      }
    }
  }
  // head:true asks for the count only — postgrest sends no body.
  if (call.head && !error) {
    if (count === null && Array.isArray(part.data)) count = part.data.length;
    data = null;
  }
  return {
    data,
    error,
    status,
    statusText: part.statusText ?? (error ? "Bad Request" : "OK"),
    count,
  };
}

export function makeQueryFake(script: QueryScript = {}): QueryFake {
  const initial = script;
  const queues = new Map<string, QueueEntry[]>();
  /** defer() with no table: intercepts the next call whatever its table is. */
  const anyQueue: QueueEntry[] = [];
  const calls: RecordedCall[] = [];

  const loadScript = (s: QueryScript) => {
    queues.clear();
    for (const [table, entry] of Object.entries(s)) queues.set(table, toQueue(entry));
  };
  loadScript(initial);

  const takeEntry = (call: RecordedCall): ScriptEntry => {
    // A table-less defer wins over everything; then this table's own queue (into
    // whose FRONT a table-scoped defer was unshifted); then the "*" fallback.
    const candidates = [anyQueue, queues.get(call.table), queues.get("*")];
    for (const q of candidates) {
      if (!q || q.length === 0) continue;
      const head = q[0];
      if (head.once) q.shift();
      return head.entry;
    }
    return DEFAULT_ENTRY;
  };

  function makeBuilder(call: RecordedCall): QueryBuilderFake {
    let run: Promise<QueryResult> | null = null;

    const exec = (): Promise<QueryResult> => {
      if (run) return run;
      call.awaited = true;
      const entry = takeEntry(call);
      run = Promise.resolve(typeof entry === "function" ? entry(call) : entry).then(
        (part) => {
          const result = normalize(part ?? {}, call);
          call.settled = true;
          call.result = result;
          return result;
        }
      );
      return run;
    };

    const addFilter = (op: string, column: string, value: unknown, operator?: string) => {
      call.filters.push(operator ? { op, column, value, operator } : { op, column, value });
      if (op === "eq") call.eq[column] = value;
      return builder;
    };
    const setVerb = (
      verb: PostgrestVerb,
      values: unknown,
      options?: Record<string, unknown>
    ) => {
      call.verb = verb;
      call.values = values;
      if (options) call.options = { ...(call.options ?? {}), ...options };
      return builder;
    };
    const addModifier = (op: RecordedModifier["op"], args: unknown[]) => {
      call.modifiers.push({ op, args });
      return builder;
    };

    const builder: QueryBuilderFake = {
      select(columns = "*", options) {
        // A .select() on a write verb is the write asking for its rows back —
        // the only way lib/write-guard.ts can tell a no-op write from a real one.
        if (call.verb !== "select" && call.verb !== "rpc") call.selectAfterWrite = true;
        call.columns = columns;
        if (options) {
          call.options = { ...(call.options ?? {}), ...options };
          if (options.count) call.countRequested = options.count;
          if (options.head) call.head = true;
        }
        return builder;
      },
      insert: (values, options) => setVerb("insert", values, options),
      update: (values, options) => setVerb("update", values, options),
      upsert: (values, options) => setVerb("upsert", values, options),
      delete: (options) => setVerb("delete", undefined, options),

      eq: (c, v) => addFilter("eq", c, v),
      neq: (c, v) => addFilter("neq", c, v),
      gt: (c, v) => addFilter("gt", c, v),
      gte: (c, v) => addFilter("gte", c, v),
      lt: (c, v) => addFilter("lt", c, v),
      lte: (c, v) => addFilter("lte", c, v),
      like: (c, v) => addFilter("like", c, v),
      ilike: (c, v) => addFilter("ilike", c, v),
      is: (c, v) => addFilter("is", c, v),
      in: (c, v) => addFilter("in", c, v),
      contains: (c, v) => addFilter("contains", c, v),
      overlaps: (c, v) => addFilter("overlaps", c, v),
      match: (q) => {
        for (const [c, v] of Object.entries(q)) addFilter("eq", c, v);
        return builder;
      },
      not: (c, operator, v) => addFilter("not", c, v, operator),
      or: (filters) => addFilter("or", "", filters),
      filter: (c, operator, v) => addFilter("filter", c, v, operator),

      order: (column, options) => addModifier("order", [column, options]),
      limit: (count, options) => addModifier("limit", [count, options]),
      range: (from, to, options) => addModifier("range", [from, to, options]),
      abortSignal: () => builder,
      throwOnError: () => builder,
      returns: () => builder,
      overrideTypes: () => builder,

      maybeSingle() {
        call.terminal = "maybeSingle";
        return builder;
      },
      single() {
        call.terminal = "single";
        return builder;
      },

      then: (onfulfilled, onrejected) => exec().then(onfulfilled, onrejected),
      catch: (onrejected) => exec().catch(onrejected),
      finally: (onfinally) => exec().finally(onfinally),

      call,
    };
    return builder;
  }

  const start = (table: string, verb: PostgrestVerb, values?: unknown): QueryBuilderFake => {
    const call: RecordedCall = {
      table,
      verb,
      values,
      options: null,
      columns: null,
      selectAfterWrite: false,
      countRequested: null,
      head: false,
      filters: [],
      eq: {},
      modifiers: [],
      terminal: null,
      awaited: false,
      settled: false,
      result: null,
    };
    calls.push(call);
    return makeBuilder(call);
  };

  return {
    from: (table) => start(table, "select"),
    rpc: (fn, args, options) => {
      const b = start(`rpc:${fn}`, "rpc", args);
      if (options) b.call.options = { ...options };
      return b;
    },
    calls,
    callsTo: (table, verb) =>
      calls.filter((c) => c.table === table && (!verb || c.verb === verb)),
    lastCall: (table, verb) => {
      for (let i = calls.length - 1; i >= 0; i--) {
        const c = calls[i];
        if (table && c.table !== table) continue;
        if (verb && c.verb !== verb) continue;
        return c;
      }
      return undefined;
    },
    pending: () => calls.filter((c) => c.awaited && !c.settled),
    setScript: (s) => loadScript(s),
    setTable: (table, entry) => queues.set(table, toQueue(entry)),
    defer(table?: string) {
      let settle: ((part: ScriptResult) => void) | null = null;
      let blow: ((reason: unknown) => void) | null = null;
      let taken = false;
      let done = false;
      const promise = new Promise<ScriptResult>((res, rej) => {
        settle = res;
        blow = rej;
      });
      const entry: ScriptEntry = () => {
        taken = true;
        return promise;
      };
      if (table === undefined) {
        anyQueue.push({ entry, once: true });
      } else {
        const q = queues.get(table) ?? [];
        q.unshift({ entry, once: true });
        queues.set(table, q);
      }
      return {
        get taken() {
          return taken;
        },
        get pending() {
          return taken && !done;
        },
        resolve(result: ScriptResult = {}) {
          done = true;
          settle?.(result);
        },
        reject(reason?: unknown) {
          done = true;
          blow?.(reason);
        },
      };
    },
    clearCalls: () => {
      calls.length = 0;
    },
    reset: () => {
      calls.length = 0;
      anyQueue.length = 0;
      loadScript(initial);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Realtime channel
// ─────────────────────────────────────────────────────────────────────────────

export type ChannelStatus = "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED";

export interface RegisteredHandler {
  /** "broadcast" | "presence" | "postgres_changes" | "system" */
  type: string;
  /** the 2nd argument when it is a filter, e.g. { event: "state" } */
  filter: Record<string, unknown> | null;
  handler: (payload: any) => void;
}

export interface SentBroadcast {
  type?: string;
  event?: string;
  payload?: any;
  [k: string]: unknown;
}

export interface ChannelFake {
  /** As RealtimeClient stores it: "realtime:<topic>". mgmt-outbox matches on this. */
  readonly topic: string;
  /** The raw topic string passed to supabase.channel(). */
  readonly name: string;
  readonly config: unknown;

  on: Mock<(type: string, a?: any, b?: any) => ChannelFake>;
  send: Mock<(payload: SentBroadcast, opts?: unknown) => Promise<string>>;
  subscribe: Mock<(cb?: (status: ChannelStatus, err?: Error) => void) => ChannelFake>;
  unsubscribe: Mock<() => Promise<string>>;
  track: Mock<(state: unknown) => Promise<string>>;
  untrack: Mock<() => Promise<string>>;
  presenceState: Mock<() => Record<string, unknown[]>>;

  /** Every .on() registration, in order. */
  readonly handlers: RegisteredHandler[];
  /** Every .send() payload, in order. */
  readonly sent: SentBroadcast[];
  /** Every callback given to .subscribe(). */
  readonly statusCallbacks: Array<(status: ChannelStatus, err?: Error) => void>;
  readonly status: ChannelStatus | null;
  readonly subscribed: boolean;
  readonly removed: boolean;

  /** Deliver a broadcast to the handlers registered for `event`, in the shape
   *  supabase delivers it: { type: "broadcast", event, payload }. Returns how
   *  many handlers ran — 0 means the component never registered, which is the
   *  failure a handoff test is actually looking for. */
  emit(event: string, payload?: any): number;
  /** The general form, for a non-broadcast `.on(type, …)`. */
  emitRaw(type: string, arg: any, match?: (filter: Record<string, unknown> | null) => boolean): number;
  /** Fire the .subscribe() status callback(s). Nothing fires on its own. */
  setStatus(status: ChannelStatus, err?: Error): void;
  /** The last payload sent for `event`, if any. */
  lastSent(event?: string): SentBroadcast | undefined;
  /** Internal: flipped by SupabaseFake.removeChannel. */
  markRemoved(): void;
}

export interface ChannelFakeOptions {
  /** Fire this status synchronously from .subscribe(). Default: nothing fires —
   *  the test causes the transition. */
  autoStatus?: ChannelStatus | null;
  /** What .send() resolves to. Default "ok". */
  sendResult?: string;
  config?: unknown;
}

export function makeChannelFake(
  name = "test-topic",
  options: ChannelFakeOptions = {}
): ChannelFake {
  const handlers: RegisteredHandler[] = [];
  const sent: SentBroadcast[] = [];
  const statusCallbacks: Array<(status: ChannelStatus, err?: Error) => void> = [];
  let status: ChannelStatus | null = null;
  let removed = false;

  // Annotated (not inferred) because half these members return `ch` itself, and
  // an un-annotated const referenced in its own initializer is an implicit any.
  const ch: ChannelFake = {
    topic: `realtime:${name}`,
    name,
    config: options.config ?? null,
    handlers,
    sent,
    statusCallbacks,
    get status() {
      return status;
    },
    get subscribed() {
      return status === "SUBSCRIBED";
    },
    get removed() {
      return removed;
    },
    on: vi.fn((type: string, a?: any, b?: any) => {
      const hasFilter = typeof a !== "function";
      handlers.push({
        type,
        filter: hasFilter ? ((a ?? null) as Record<string, unknown> | null) : null,
        handler: (hasFilter ? b : a) as (payload: any) => void,
      });
      return ch;
    }),
    send: vi.fn((payload: SentBroadcast) => {
      sent.push(payload);
      return Promise.resolve(options.sendResult ?? "ok");
    }),
    subscribe: vi.fn((cb?: (s: ChannelStatus, err?: Error) => void) => {
      if (cb) statusCallbacks.push(cb);
      if (options.autoStatus) {
        status = options.autoStatus;
        cb?.(options.autoStatus);
      }
      return ch;
    }),
    unsubscribe: vi.fn(() => {
      status = "CLOSED";
      return Promise.resolve("ok");
    }),
    track: vi.fn(() => Promise.resolve("ok")),
    untrack: vi.fn(() => Promise.resolve("ok")),
    presenceState: vi.fn(() => ({}) as Record<string, unknown[]>),

    emit(event: string, payload?: any) {
      return ch.emitRaw(
        "broadcast",
        { type: "broadcast", event, payload },
        (filter) => !filter?.event || filter.event === event
      );
    },
    emitRaw(
      type: string,
      arg: any,
      match?: (filter: Record<string, unknown> | null) => boolean
    ) {
      let ran = 0;
      // Copy first: a handler that registers another handler (or tears the
      // channel down) must not mutate the list we are walking.
      for (const h of [...handlers]) {
        if (h.type !== type) continue;
        if (match && !match(h.filter)) continue;
        h.handler(arg);
        ran++;
      }
      return ran;
    },
    setStatus(next: ChannelStatus, err?: Error) {
      status = next;
      for (const cb of [...statusCallbacks]) cb(next, err);
    },
    lastSent(event?: string) {
      for (let i = sent.length - 1; i >= 0; i--) {
        if (!event || sent[i].event === event) return sent[i];
      }
      return undefined;
    },
    markRemoved() {
      removed = true;
      status = "CLOSED";
    },
  };
  return ch;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

export interface FakeUser {
  id: string;
  email: string;
  [k: string]: unknown;
}

export interface FakeSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
  user: FakeUser;
  [k: string]: unknown;
}

/** A session that satisfies hasLiveSession() (lib/auth-session.ts) — i.e. the
 *  app can prove the next PostgREST request goes out as this user, not as anon. */
export function makeSession(overrides: Partial<FakeSession> = {}): FakeSession {
  const user: FakeUser = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "seishin-mem@cueiq.local",
    ...((overrides.user as Partial<FakeUser>) ?? {}),
  } as FakeUser;
  return {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    ...overrides,
    user,
  };
}

export type AuthMethod =
  | "getSession"
  | "getUser"
  | "signInWithPassword"
  | "signOut"
  | "updateUser"
  | "refreshSession";

export interface AuthListener {
  id: string;
  callback: (event: string, session: FakeSession | null) => void;
  unsubscribe: Mock<() => void>;
  unsubscribed: boolean;
}

export interface AuthFake {
  getSession: Mock<() => Promise<{ data: { session: FakeSession | null }; error: null }>>;
  getUser: Mock<
    () => Promise<{ data: { user: FakeUser | null }; error: PostgrestErrorLike | null }>
  >;
  signInWithPassword: Mock<
    (credentials: { email: string; password: string }) => Promise<{
      data: { user: FakeUser | null; session: FakeSession | null };
      error: PostgrestErrorLike | null;
    }>
  >;
  signOut: Mock<() => Promise<{ error: PostgrestErrorLike | null }>>;
  updateUser: Mock<
    (attrs: Record<string, unknown>) => Promise<{
      data: { user: FakeUser | null };
      error: PostgrestErrorLike | null;
    }>
  >;
  refreshSession: Mock<
    () => Promise<{ data: { session: FakeSession | null }; error: PostgrestErrorLike | null }>
  >;
  onAuthStateChange: Mock<
    (cb: (event: string, session: FakeSession | null) => void) => {
      data: { subscription: { id: string; callback: unknown; unsubscribe: () => void } };
    }
  >;

  /** Current session (also what getUser() answers from). */
  readonly session: FakeSession | null;
  setSession(session: FakeSession | null): void;
  /** Override what signInWithPassword answers. */
  setSignInResult(result: { error?: PostgrestErrorLike | null; session?: FakeSession | null }): void;
  /** Make a method (or "all") never settle — a black-holed network. */
  hang(method: AuthMethod | "all"): void;
  /** Stop hanging, and settle every call already parked, with today's values.
   *  App.tsx promises a late getSession() still upgrades the state — this is how
   *  you prove it. */
  release(method: AuthMethod | "all"): void;
  /** Push an auth event at every live onAuthStateChange listener. */
  emit(event: string, session?: FakeSession | null): void;
  readonly listeners: AuthListener[];
  /** How many listeners were unsubscribed — a cleanup-leak assertion. */
  unsubscribedCount(): number;
}

export function makeAuthFake(initialSession: FakeSession | null = null): AuthFake {
  let session: FakeSession | null = initialSession;
  let signIn: { error?: PostgrestErrorLike | null; session?: FakeSession | null } = {};
  const hung = new Set<AuthMethod>();
  const parked = new Map<AuthMethod, Array<(v: any) => void>>();
  const listeners: AuthListener[] = [];
  const ALL: AuthMethod[] = [
    "getSession",
    "getUser",
    "signInWithPassword",
    "signOut",
    "updateUser",
    "refreshSession",
  ];

  /** Either answer now, or park a promise that only release() can settle. */
  function gated<T>(method: AuthMethod, value: () => T): Promise<T> {
    if (!hung.has(method)) return Promise.resolve(value());
    return new Promise<T>((resolve) => {
      const list = parked.get(method) ?? [];
      list.push(() => resolve(value()));
      parked.set(method, list);
    });
  }

  const auth: AuthFake = {
    getSession: vi.fn(() => gated("getSession", () => ({ data: { session }, error: null }))),
    getUser: vi.fn(() =>
      gated("getUser", () => ({
        data: { user: session?.user ?? null },
        error: session ? null : { message: "Auth session missing!" },
      }))
    ),
    signInWithPassword: vi.fn((_credentials: { email: string; password: string }) =>
      gated("signInWithPassword", () => {
        const error = signIn.error ?? null;
        if (!error) session = signIn.session ?? session ?? makeSession();
        return {
          data: { user: error ? null : (session?.user ?? null), session: error ? null : session },
          error,
        };
      })
    ),
    signOut: vi.fn(() =>
      gated("signOut", () => {
        session = null;
        return { error: null };
      })
    ),
    updateUser: vi.fn((_attrs: Record<string, unknown>) =>
      gated("updateUser", () => ({ data: { user: session?.user ?? null }, error: null }))
    ),
    refreshSession: vi.fn(() =>
      gated("refreshSession", () => ({ data: { session }, error: null }))
    ),
    onAuthStateChange: vi.fn((cb: (event: string, s: FakeSession | null) => void) => {
      const entry: AuthListener = {
        id: `sub-${listeners.length + 1}`,
        callback: cb,
        unsubscribe: vi.fn(() => {
          entry.unsubscribed = true;
        }),
        unsubscribed: false,
      };
      listeners.push(entry);
      return {
        data: {
          subscription: { id: entry.id, callback: cb, unsubscribe: entry.unsubscribe },
        },
      };
    }),

    get session() {
      return session;
    },
    setSession(next) {
      session = next;
    },
    setSignInResult(result) {
      signIn = result;
    },
    hang(method) {
      if (method === "all") ALL.forEach((m) => hung.add(m));
      else hung.add(method);
    },
    release(method) {
      const targets = method === "all" ? ALL : [method];
      for (const m of targets) {
        hung.delete(m);
        const list = parked.get(m);
        parked.delete(m);
        list?.forEach((settle) => settle(undefined));
      }
    },
    emit(event, next) {
      if (next !== undefined) session = next;
      for (const l of [...listeners]) {
        if (!l.unsubscribed) l.callback(event, session);
      }
    },
    listeners,
    unsubscribedCount: () => listeners.filter((l) => l.unsubscribed).length,
  };
  return auth;
}

// ─────────────────────────────────────────────────────────────────────────────
// The composed client
// ─────────────────────────────────────────────────────────────────────────────

export interface SupabaseFakeOptions {
  script?: QueryScript;
  session?: FakeSession | null;
  /** Status .subscribe() fires by itself. Default null = the test fires it. */
  autoChannelStatus?: ChannelStatus | null;
  /** Return the SAME channel for a topic already open, like RealtimeClient.
   *  Default true — mgmt-outbox's getChannels() reuse path depends on it. */
  reuseChannels?: boolean;
}

/** Exactly the object a vi.mock("@/lib/supabase/client") factory should hand back
 *  from createClient(). */
export interface SupabaseFake {
  from: Mock<(table: string) => QueryBuilderFake>;
  rpc: Mock<(fn: string, args?: unknown, options?: Record<string, unknown>) => QueryBuilderFake>;
  auth: AuthFake;
  channel: Mock<(topic: string, config?: unknown) => ChannelFake>;
  getChannels: Mock<() => ChannelFake[]>;
  removeChannel: Mock<(ch: ChannelFake) => Promise<string>>;
  removeAllChannels: Mock<() => Promise<string[]>>;

  /** The query fake underneath — scripting and recording live here. */
  readonly query: QueryFake;
  /** Alias of query.calls, same array reference. */
  readonly calls: RecordedCall[];
  /** Currently open channels (removed ones are gone). */
  readonly channels: ChannelFake[];
  /** Every channel ever opened, including removed ones, in creation order. */
  readonly allChannels: ChannelFake[];
  /** By the raw topic string passed to .channel() — e.g. liveTopic(eventId). */
  channelFor(name: string): ChannelFake | undefined;

  // Conveniences so a test rarely has to reach through .query
  setScript(script: QueryScript): void;
  setTable(table: string, entry: TableScript): void;
  defer(table?: string): DeferredResult;
  callsTo(table: string, verb?: PostgrestVerb): RecordedCall[];
  lastCall(table?: string, verb?: PostgrestVerb): RecordedCall | undefined;
  reset(): void;
}

export function makeSupabaseFake(options: SupabaseFakeOptions = {}): SupabaseFake {
  const query = makeQueryFake(options.script ?? {});
  const auth = makeAuthFake(options.session ?? null);
  const open: ChannelFake[] = [];
  const all: ChannelFake[] = [];
  const reuse = options.reuseChannels !== false;

  const client: SupabaseFake = {
    from: vi.fn((table: string) => query.from(table)),
    rpc: vi.fn((fn: string, args?: unknown, opts?: Record<string, unknown>) =>
      query.rpc(fn, args, opts)
    ),
    auth,
    channel: vi.fn((topic: string, config?: unknown) => {
      if (reuse) {
        const existing = open.find((c) => c.name === topic);
        // RealtimeClient hands back the open channel for a topic instead of
        // opening a second one — and subscribe() on it is a silent no-op.
        if (existing) return existing;
      }
      const ch = makeChannelFake(topic, {
        autoStatus: options.autoChannelStatus ?? null,
        config,
      });
      open.push(ch);
      all.push(ch);
      return ch;
    }),
    getChannels: vi.fn(() => [...open]),
    removeChannel: vi.fn((ch: ChannelFake) => {
      const i = open.indexOf(ch);
      if (i >= 0) open.splice(i, 1);
      ch.markRemoved();
      return Promise.resolve("ok");
    }),
    removeAllChannels: vi.fn(() => {
      const removed = open.splice(0, open.length);
      removed.forEach((c) => c.markRemoved());
      return Promise.resolve(removed.map(() => "ok"));
    }),

    query,
    calls: query.calls,
    channels: open,
    allChannels: all,
    channelFor: (name) => all.find((c) => c.name === name),

    setScript: (s) => query.setScript(s),
    setTable: (t, e) => query.setTable(t, e),
    defer: (t) => query.defer(t),
    callsTo: (t, v) => query.callsTo(t, v),
    lastCall: (t, v) => query.lastCall(t, v),
    reset: () => {
      query.reset();
      open.length = 0;
      all.length = 0;
    },
  };
  return client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Media elements
// ─────────────────────────────────────────────────────────────────────────────

export interface MediaState {
  paused: boolean;
  currentTime: number;
  src: string;
  duration: number;
  muted: boolean;
  volume: number;
  playbackRate: number;
  ended: boolean;
}

export type MediaCallType = "play" | "pause" | "load" | keyof MediaState;

export interface MediaCall {
  /** Index of the element in `elements` — 0 is the first `new Audio()`. */
  index: number;
  element: HTMLMediaElement;
  /** A method name, or the property that was written. */
  type: MediaCallType;
  value?: unknown;
}

export interface MediaInstrumentation {
  /** Elements in creation order. Live Mode makes the primary first, then the
   *  secondary — but it SWAPS the two refs on a crossfade, so this is creation
   *  order, not current role. */
  readonly elements: HTMLMediaElement[];
  index(el: HTMLMediaElement): number;
  /** elements[0] / elements[1] — the pair Live Mode creates on mount. */
  first(): HTMLMediaElement | undefined;
  second(): HTMLMediaElement | undefined;
  state(el: HTMLMediaElement): MediaState;
  /** Drive an element the way the browser would. Fires no events by itself. */
  set(el: HTMLMediaElement, patch: Partial<MediaState>): void;
  /** Dispatch a media event (ended, timeupdate, loadedmetadata, playing, pause…). */
  emit(el: HTMLMediaElement, type: string): void;
  readonly calls: MediaCall[];
  callsFor(el: HTMLMediaElement): MediaCall[];
  /** The prototype-level spies — every element shares them; use callsFor()/index()
   *  to tell instances apart. */
  play: Mock<() => Promise<void>>;
  pause: Mock<() => void>;
  /** Make every subsequent play() reject — the autoplay-blocked path. */
  rejectPlay(error?: unknown): void;
  resolvePlay(): void;
  /** When true, play()/pause() dispatch "play"/"playing"/"pause" themselves.
   *  Off by default: a transition the test did not cause is a race. */
  setAutoEvents(on: boolean): void;
  restore(): void;
}

export interface InstrumentMediaOptions {
  autoEvents?: boolean;
  /** Register restore() with onTestFinished. Default true — prototype patches
   *  must not leak into the next test. */
  autoRestore?: boolean;
  /** Starting values for every element. */
  defaults?: Partial<MediaState>;
}

const MEDIA_PROPS: Array<keyof MediaState> = [
  "paused",
  "currentTime",
  "src",
  "duration",
  "muted",
  "volume",
  "playbackRate",
  "ended",
];

export function instrumentMediaElements(
  options: InstrumentMediaOptions = {}
): MediaInstrumentation {
  const proto = HTMLMediaElement.prototype;
  const store = new WeakMap<HTMLMediaElement, MediaState>();
  const elements: HTMLMediaElement[] = [];
  const calls: MediaCall[] = [];
  let autoEvents = options.autoEvents === true;
  let playRejection: { error: unknown } | null = null;

  const defaults = (): MediaState => ({
    paused: true,
    currentTime: 0,
    src: "",
    // 0, not NaN: a component that renders duration would render "NaN" and the
    // assertion failure would look like a formatting bug.
    duration: 0,
    muted: false,
    volume: 1,
    playbackRate: 1,
    ended: false,
    ...options.defaults,
  });

  function register(el: HTMLMediaElement): MediaState {
    let s = store.get(el);
    if (!s) {
      s = defaults();
      store.set(el, s);
      elements.push(el);
    }
    return s;
  }
  const indexOf = (el: HTMLMediaElement) => elements.indexOf(el);
  const record = (el: HTMLMediaElement, type: MediaCallType, value?: unknown) => {
    calls.push({ index: indexOf(el), element: el, type, value });
  };

  // Save what we are about to shadow so restore() puts back exactly what
  // test/setup/dom.ts installed (its play/pause/load vi.fn stubs included).
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const shadow = (key: string, descriptor: PropertyDescriptor) => {
    saved.set(key, Object.getOwnPropertyDescriptor(proto, key));
    Object.defineProperty(proto, key, { configurable: true, ...descriptor });
  };

  // Per-INSTANCE values through prototype accessors: Live Mode's elements are
  // built with `new Audio()` in an effect and kept on refs, never mounted, so
  // there is nothing in the document to query or to patch individually.
  for (const prop of MEDIA_PROPS) {
    shadow(prop, {
      get(this: HTMLMediaElement) {
        return register(this)[prop];
      },
      set(this: HTMLMediaElement, value: unknown) {
        const s = register(this) as unknown as Record<string, unknown>;
        s[prop] = prop === "src" ? String(value) : value;
        record(this, prop, s[prop]);
      },
    });
  }

  const play = vi.fn(function (this: HTMLMediaElement) {
    const s = register(this);
    record(this, "play");
    if (playRejection) return Promise.reject(playRejection.error);
    s.paused = false;
    s.ended = false;
    if (autoEvents) {
      this.dispatchEvent(new Event("play"));
      this.dispatchEvent(new Event("playing"));
    }
    return Promise.resolve();
  });
  const pause = vi.fn(function (this: HTMLMediaElement) {
    const s = register(this);
    record(this, "pause");
    s.paused = true;
    if (autoEvents) this.dispatchEvent(new Event("pause"));
  });
  const load = vi.fn(function (this: HTMLMediaElement) {
    record(this, "load");
  });
  shadow("play", { writable: true, value: play });
  shadow("pause", { writable: true, value: pause });
  shadow("load", { writable: true, value: load });

  // `new Audio()` is the only way Live Mode creates elements, and creation ORDER
  // is what distinguishes the primary from the pre-roll secondary. A Proxy keeps
  // the real constructor (and so the real prototype chain) intact.
  const OriginalAudio = window.Audio;
  const TrackedAudio = new Proxy(OriginalAudio, {
    construct(target, args) {
      const el = Reflect.construct(target, args) as HTMLAudioElement;
      register(el);
      return el;
    },
  });
  window.Audio = TrackedAudio;

  let restored = false;
  const handle: MediaInstrumentation = {
    elements,
    index: indexOf,
    first: () => elements[0],
    second: () => elements[1],
    state: (el) => ({ ...register(el) }),
    set(el, patch) {
      Object.assign(register(el), patch);
    },
    emit(el, type) {
      el.dispatchEvent(new Event(type));
    },
    calls,
    callsFor: (el) => calls.filter((c) => c.element === el),
    play,
    pause,
    rejectPlay(error: unknown = new DOMException("play() blocked", "NotAllowedError")) {
      playRejection = { error };
    },
    resolvePlay() {
      playRejection = null;
    },
    setAutoEvents(on) {
      autoEvents = on;
    },
    restore() {
      if (restored) return;
      restored = true;
      window.Audio = OriginalAudio;
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(proto, key, descriptor);
        else delete (proto as unknown as Record<string, unknown>)[key];
      }
    },
  };

  if (options.autoRestore !== false) {
    try {
      onTestFinished(() => handle.restore());
    } catch {
      // Called outside a running test (a top-level beforeAll, say) — the caller
      // owns restore() then. Never let the bookkeeping be the thing that fails.
    }
  }
  return handle;
}
