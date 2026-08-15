// Does the local Realtime stub speak enough of the protocol to be worth trusting?
//
// desktop/scripts/smoke-realtime.mjs exists so the two-device smoke can run the PA
// and the joining phone as two REAL processes talking over a REAL socket. That is
// only worth anything if the stub is faithful: a stub that silently fails to relay
// a broadcast turns the two-device scenario into two single-device scenarios that
// happen to run at once — green, and proving the opposite of what it claims.
//
// So nothing here asserts on the stub's internals either. Every case below drives a
// REAL supabase-js client, through the app's OWN channel helper
// (lib/realtime.ts's privateChannel + liveTopic — the same functions
// components/event/live-mode.tsx calls), at a real server on a real socket.
//
// ⚠️ THE CASE THAT MATTERS MOST IS THE ENCODING ONE. @supabase/realtime-js 2.108
// encodes a client→server BROADCAST as packed BINARY and everything else as a JSON
// array, and neither format is anything this repo controls. A version bump that
// changes either one would not break a build, a typecheck or a lint — it would make
// the two-device smoke hang, twenty minutes into a release, with no message that
// points here. This file is that message.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { liveTopic, privateChannel } from "@/lib/realtime";
// A plain dependency-free .mjs, by design — the smoke runner imports it straight
// from `node`. tsc infers its shape from the JS (desktop/tsconfig.json sets
// allowJs), so a typo in the fixture fails the typecheck and not only the run.
import { attachSmokeRealtime, decodeClientMessage } from "./smoke-realtime.mjs";

const ANON_KEY = "sb_publishable_smoke_realtime_fixture";
const EVENT_ID = "00000000-0000-4000-8000-000000000031";

type Realtime = ReturnType<typeof attachSmokeRealtime>;

let server: http.Server;
let realtime: Realtime;
let url = "";

/** Sign-in is not part of this: the stub authorizes nothing (see its header), and
 *  supabase-js opens the socket with the anon key regardless. What IS exercised is
 *  the app's own channel construction — private topic, self:false. */
const clientFor = (): SupabaseClient =>
  createClient(url, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

/** Subscribe, and resolve only on SUBSCRIBED — never on the first callback.
 *  supabase-js reports intermediate statuses, and a helper that resolved on any of
 *  them would let a test send into a channel that never joined, where the push is
 *  buffered forever and the assertion times out somewhere unrelated. */
function subscribed(channel: ReturnType<typeof privateChannel>, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: never reached SUBSCRIBED`)), 10_000);
    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer);
        reject(new Error(`${label}: ${status} ${err ? String(err) : ""}`));
      }
    });
  });
}

/** Wait for a predicate on a growing array, or fail with what WAS collected — a
 *  bare timeout tells you nothing about whether one message arrived or none did. */
async function until<T>(what: string, list: T[], done: (l: T[]) => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (done(list)) return;
    if (Date.now() >= deadline) {
      throw new Error(`${what} — saw ${list.length}: ${JSON.stringify(list).slice(0, 400)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  // A bare HTTP server: this file is about the socket only. In the smoke the same
  // server also answers PostgREST and GoTrue, which is what makes ONE host rewrite
  // in main.cjs enough to move the whole backend.
  server = http.createServer((_req, res) => {
    res.writeHead(501).end();
  });
  realtime = attachSmokeRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  realtime.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the realtime stub, driven by a real supabase-js client", () => {
  it("relays a live-state broadcast from one device to the other, and not back to the sender", async () => {
    const pa = clientFor();
    const phone = clientFor();
    const topic = liveTopic(EVENT_ID);
    const paChannel = privateChannel(pa, topic);
    const phoneChannel = privateChannel(phone, topic);

    const heardByPhone: Record<string, unknown>[] = [];
    const heardByPa: Record<string, unknown>[] = [];
    phoneChannel.on("broadcast", { event: "state" }, ({ payload }) => heardByPhone.push(payload));
    paChannel.on("broadcast", { event: "state" }, ({ payload }) => heardByPa.push(payload));

    try {
      await subscribed(phoneChannel, "phone");
      await subscribed(paChannel, "PA");

      // The real shape: what live-mode.tsx's statePayload() sends when the show is
      // running. Asserted field-for-field below because a relay that dropped or
      // re-wrapped the payload would still deliver "a message".
      await paChannel.send({
        type: "broadcast",
        event: "state",
        payload: {
          sender: "pa-device",
          begun: true,
          running: true,
          currentIndex: 2,
          fromController: true,
          controllerSince: 1_700_000_000_000,
        },
      });

      await until("the phone never heard the PA's state", heardByPhone, (l) => l.length === 1);
      expect(heardByPhone[0]).toMatchObject({
        sender: "pa-device",
        begun: true,
        currentIndex: 2,
        fromController: true,
        controllerSince: 1_700_000_000_000,
      });
      // broadcast.self is false everywhere in this app because every sender applies
      // its own change locally first. An echo would arrive at the PA as a peer's
      // state — indistinguishable from a second controller, which is the exact
      // failure the two-device scenario hunts.
      expect(heardByPa).toEqual([]);
    } finally {
      await pa.removeAllChannels();
      await phone.removeAllChannels();
    }
  });

  it("delivers only to devices on the SAME topic", async () => {
    const a = clientFor();
    const b = clientFor();
    const onShow = privateChannel(a, liveTopic(EVENT_ID));
    const onOther = privateChannel(b, liveTopic("00000000-0000-4000-8000-0000000000ff"));
    const heard: unknown[] = [];
    onOther.on("broadcast", { event: "state" }, ({ payload }) => heard.push(payload));

    try {
      await subscribed(onOther, "other event");
      await subscribed(onShow, "this event");
      await onShow.send({ type: "broadcast", event: "state", payload: { begun: true } });
      // Give a wrong-topic delivery time to happen before declaring it did not.
      await new Promise((r) => setTimeout(r, 300));
      expect(heard).toEqual([]);
    } finally {
      await a.removeAllChannels();
      await b.removeAllChannels();
    }
  });

  it("records every message it decoded, and decodes them all", async () => {
    // The anti-vacuity hook the two-device scenario reads: if the app's messages
    // never crossed this server, whatever the two devices agreed on they agreed on
    // somewhere else. A DECODE_ERROR entry is how a changed wire format surfaces.
    expect(realtime.messages.some((m) => m.event === "DECODE_ERROR")).toBe(false);
    expect(realtime.messages.some((m) => m.event === "PARSE_ERROR")).toBe(false);
    expect(realtime.messages.some((m) => m.event === "phx_join")).toBe(true);
    expect(realtime.broadcastsOf("state")).toBeGreaterThanOrEqual(2);
  });

  it("answers a heartbeat, so a long-running show's socket is not dropped", async () => {
    // A show runs for hours; phoenix heartbeats every 30s and tears the socket down
    // when two go unanswered. The smoke is far shorter than that, which is exactly
    // why this is asserted here instead of being left to a scenario that would
    // never notice.
    const client = clientFor();
    const channel = privateChannel(client, liveTopic(EVENT_ID));
    try {
      await subscribed(channel, "heartbeat client");
      const before = realtime.messages.length;
      // Reach past the public API for the one thing it does not expose: phoenix's
      // heartbeat is on a timer measured in tens of seconds.
      const socket = (client.realtime as unknown as { sendHeartbeat: () => void }).sendHeartbeat;
      expect(typeof socket).toBe("function");
      (client.realtime as unknown as { sendHeartbeat: () => void }).sendHeartbeat();
      await until(
        "the heartbeat never reached the stub",
        realtime.messages,
        (l) => l.length > before && l.some((m) => m.event === "heartbeat")
      );
    } finally {
      await client.removeAllChannels();
    }
  });
});

describe("the wire format it has to keep up with", () => {
  it("decodes the JSON-array form the client uses for everything but broadcast", () => {
    const raw = JSON.stringify(["1", "2", "realtime:live:x", "phx_join", { config: {} }]);
    expect(decodeClientMessage(Buffer.from(raw, "utf8"), false)).toEqual({
      join_ref: "1",
      ref: "2",
      topic: "realtime:live:x",
      event: "phx_join",
      payload: { config: {} },
    });
  });

  it("decodes the packed BINARY form realtime-js uses for a broadcast push", async () => {
    // Encoded by the REAL serializer, not by hand: hand-built bytes would keep
    // passing on the day the layout changes, which is the only day this test is
    // for. Imported from the root copy — the same one vitest.config.ts pins the
    // desktop project's supabase-js to, and therefore the same code the app runs.
    const { default: Serializer } = await import("@supabase/realtime-js/dist/module/lib/serializer");
    const serializer = new Serializer();
    let encoded: ArrayBuffer | string | undefined;
    serializer.encode(
      {
        join_ref: "7",
        ref: "8",
        topic: "realtime:live:x",
        event: "broadcast",
        payload: { type: "broadcast", event: "state", payload: { begun: true, currentIndex: 3 } },
      },
      (result: ArrayBuffer | string) => {
        encoded = result;
      }
    );
    expect(encoded).toBeInstanceOf(ArrayBuffer);

    const decoded = decodeClientMessage(Buffer.from(encoded as ArrayBuffer), true);
    expect(decoded).toEqual({
      join_ref: "7",
      ref: "8",
      topic: "realtime:live:x",
      event: "broadcast",
      payload: { type: "broadcast", event: "state", payload: { begun: true, currentIndex: 3 } },
    });
  });

  it("refuses a binary kind it does not implement instead of guessing", () => {
    const bogus = Buffer.from([9, 0, 0, 0, 0, 0, 1]);
    expect(() => decodeClientMessage(bogus, true)).toThrow(/kind 9 is not implemented/);
  });
});

/** Same walk as smoke-backend.test.ts's, and for the same reason. */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let hops = 0; hops < 8; hops++) {
    if (fs.existsSync(path.join(dir, "lib")) && fs.existsSync(path.join(dir, "desktop", "src"))) {
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
        if (fs.readFileSync(full, "utf8").includes("smoke-realtime")) {
          offenders.push(path.relative(repoRoot, full));
        }
      }
    };
    walk(path.join(repoRoot, "desktop", "src"));
    walk(path.join(repoRoot, "lib"));
    expect(offenders).toEqual([]);
  });
});
